import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';

const fps = 30;

export function browserMouse(page) {
  let cursor = { x: 0, y: 0 };
  async function move(point, seconds) {
    const start = performance.now();
    const from = cursor;
    const steps = Math.max(1, Math.round(seconds * fps));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const wait = start + t * seconds * 1000 - performance.now();
      if (wait > 0) await delay(wait);
      await page.mouse.move(from.x + (point.x - from.x) * t, from.y + (point.y - from.y) * t);
    }
    cursor = point;
  }
  return async (action, points, seconds = 0) => {
    if (action === 'move') return move(points[0], seconds);
    if (action !== 'click' && action !== 'drag') throw new Error(`未知的浏览器鼠标动作：${action}`);
    await page.mouse.down();
    try {
      if (action === 'click') await delay(140);
      else for (const point of points.slice(1)) await move(point, seconds / (points.length - 1));
    } finally {
      await page.mouse.up();
    }
  };
}

function installOverlay({ title, badge, captionSize }) {
  // This overlay lives only in the disposable capture tab.
  const host = document.createElement('div');
  host.id = 'tinylens-demo-capture';
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  host.style.setProperty('--capture-caption-size', `${captionSize}px`);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      .footer { position:absolute; inset:auto 16px 0; height:26px; display:grid; place-items:center;
        color:#233e67; font:600 var(--capture-caption-size)/26px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif; }
      .badge { position:absolute; right:0; color:#435b7d; font-size:clamp(12px,.75em,16px); }
      .cursor { position:absolute; left:0; top:0; filter:drop-shadow(0 1px 2px #17294480); }
      .ring { position:absolute; left:-12px; top:-13px; width:26px; height:26px; border-radius:50%;
        border:2px solid #427fe2; background:#87aff44d; opacity:0; transition:opacity 100ms; }
      .pressed .ring { opacity:1; }
      svg { position:relative; display:block; }
    </style>
    <div class="footer"><span class="caption"></span><span class="badge"></span></div>
    <div class="cursor" hidden><div class="ring"></div>
      <svg width="21" height="25" viewBox="0 0 21 25" aria-hidden="true">
        <path d="M2 1.5 17.5 15.5 10.5 16.3 7.5 22.5Z" fill="#fff" stroke="#173358" stroke-width="1.8" stroke-linejoin="round"/>
      </svg>
    </div>`;
  shadow.querySelector('.caption').textContent = title;
  shadow.querySelector('.badge').textContent = badge;
  const cursor = shadow.querySelector('.cursor');
  addEventListener('pointermove', event => {
    cursor.hidden = false;
    cursor.style.transform = `translate(${event.clientX - 2}px,${event.clientY - 1}px)`;
  }, true);
  addEventListener('pointerdown', () => cursor.classList.add('pressed'), true);
  for (const type of ['pointerup', 'pointercancel']) {
    addEventListener(type, () => cursor.classList.remove('pressed'), true);
  }
  document.body.append(host);
}

function* sampleFrames(frames, seconds) {
  let index = 0;
  for (let tick = 0; tick < Math.ceil(seconds * fps); tick++) {
    while (frames[index + 1]?.time - frames[0].time <= tick * 1000 / fps) index++;
    yield frames[index].image;
  }
}

async function encode(ffmpeg, frames, seconds, output) {
  const work = await mkdtemp(join(tmpdir(), 'tinylens-browser-demo-'));
  try {
    const rendered = join(work, 'demo.mp4');
    const encoder = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin',
      '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', 'pipe:0',
      '-an', '-c:v', 'libx264', '-crf', '19', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', rendered],
    { stdio: ['pipe', 'ignore', 'pipe'], timeout: 60_000 });
    let errors = '';
    encoder.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk; });
    const [written, closed] = await Promise.allSettled([
      pipeline(Readable.from(sampleFrames(frames, seconds), { objectMode: false }), encoder.stdin),
      once(encoder, 'close'),
    ]);
    if (written.status !== 'fulfilled' || closed.status !== 'fulfilled' || closed.value[0] !== 0) {
      const reason = closed.status === 'rejected' ? closed.reason.message
        : written.status === 'rejected' ? written.reason.message : `退出状态 ${closed.value.join(' ')}`;
      throw new Error(`FFmpeg 编码失败：${errors.trim() || reason}`);
    }
    await mkdir(dirname(output), { recursive: true });
    await copyFile(rendered, output, constants.COPYFILE_EXCL);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export async function capturePage(page, ffmpeg, output, play, {
  title = 'TinyLens 工作台', badge = '合成数据', captionSize = 14,
} = {}) {
  await page.evaluate(installOverlay, { title, badge, captionSize });
  const caption = value => page.evaluate(value => {
    document.getElementById('tinylens-demo-capture').shadowRoot.querySelector('.caption').textContent = value;
  }, value);
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  let capturing = true;
  let receivedFirst;
  const firstFrame = new Promise(resolve => { receivedFirst = resolve; });
  cdp.on('Page.screencastFrame', ({ data, sessionId, metadata }) => {
    if (capturing) {
      const received = performance.now();
      const time = Number.isFinite(metadata.timestamp) ? metadata.timestamp * 1000 : performance.timeOrigin + received;
      frames.push({ time, received, image: Buffer.from(data, 'base64') });
      receivedFirst(true);
    }
    void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  const startCapture = () => cdp.send('Page.startScreencast', { format: 'jpeg', quality: 96, everyNthFrame: 1 });
  async function prepareFrame(prepare) {
    capturing = false;
    await cdp.send('Page.stopScreencast');
    await prepare();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    capturing = true;
    await startCapture();
  }
  let seconds;
  try {
    await startCapture();
    if (!await Promise.race([firstFrame, delay(4000, false, { ref: false })])) {
      throw new Error('浏览器未返回录制画面。');
    }
    await play(caption, prepareFrame);
    await delay(1900);
    seconds = (performance.now() - frames[0].received) / 1000;
  } finally {
    await cdp.send('Page.stopScreencast').catch(() => {});
    await cdp.detach().catch(() => {});
  }
  if (frames.length < 2) throw new Error('浏览器未捕获到演示动作。');
  await encode(ffmpeg, frames, seconds, output);
  return Math.ceil(seconds * fps) / fps;
}
