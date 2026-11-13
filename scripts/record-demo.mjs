import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { constants, existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { browserMouse, capturePage } from './record-demo-browser.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const demoUrl = 'http://127.0.0.1:5173/?mode=demo&design=studio&lang=zh';
const demoTitle = 'TinyLens · 合成演示';
const windowTitle = `${demoTitle} · ${process.pid}`;
const recordSeconds = 13;
const app = '/Applications/Recordly.app';
const ffmpeg = join(app, 'Contents/Resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg');
const browserPath = [
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);

const require = createRequire(import.meta.url);
function loadPlaywright() {
  try { return require('playwright'); } catch {
    const bundled = join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
    if (existsSync(bundled)) return require(bundled);
    throw new Error('找不到 Playwright。请安装 Playwright，或使用带 Playwright 的 Codex 本机运行时。');
  }
}

function run(executable, args, { input, timeout = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(executable, args, { cwd: projectRoot, timeout, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message));
        else resolve({ stdout, stderr });
      });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function until(read, ms, message) {
  const end = performance.now() + ms;
  do {
    const value = await read();
    if (value) return value;
    await delay(100);
  } while (performance.now() < end);
  throw new Error(message);
}

function isRunning(child) {
  return child && child.exitCode === null && child.signalCode === null;
}

async function stopOwned(child) {
  if (!isRunning(child)) return;
  const closed = once(child, 'exit');
  child.kill();
  await Promise.race([closed, delay(2500, undefined, { ref: false })]);
}

async function demoResponds() {
  let response;
  try { response = await fetch(demoUrl, { signal: AbortSignal.timeout(1000) }); } catch { return false; }
  if (!response.ok || !(await response.text()).includes('/src/main.tsx')) {
    throw new Error('5173 端口的响应不是当前 TinyLens 开发页面。');
  }
  return true;
}

async function openDemo(browser, profile) {
  const endpoint = await until(async () => {
    if (!isRunning(browser)) throw new Error('独立浏览器窗口启动失败。');
    const port = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '');
    const value = Number(port.split('\n')[0]);
    return value > 0 ? `http://127.0.0.1:${value}` : null;
  }, 10_000, '独立浏览器窗口未就绪。');
  const connection = await loadPlaywright().chromium.connectOverCDP(endpoint, { timeout: 10_000 });
  const page = connection.contexts()[0].pages()[0];
  if (!page) throw new Error('未找到演示浏览器页面。');
  await prepareDemoPage(page, windowTitle);
  return { connection, page };
}

async function prepareDemoPage(page, title) {
  // The synthetic page includes a read-only inbox for live AI questions. Isolate it from this take.
  await page.context().route('**/*', route => {
    const url = new URL(route.request().url());
    return url.origin === new URL(demoUrl).origin && !url.pathname.startsWith('/api/')
      ? route.continue() : route.abort();
  });
  await page.addInitScript(() => {
    addEventListener('pointermove', event => {
      if (event.isTrusted) window.tinylensDemoPointer = { x: event.clientX, y: event.clientY };
    }, true);
    window.tinylensDemoGestures = [];
    for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'gotpointercapture', 'lostpointercapture']) {
      addEventListener(type, event => {
        window.tinylensDemoGestures.push({ type, target: event.target?.tagName, button: event.button,
          buttons: event.buttons, x: event.clientX, y: event.clientY });
      }, true);
    }
  });
  await page.goto(demoUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll('[data-viewer="model"][data-stage="m1"] .science-plane img')];
    return images.length === 6 && images.every(image => image.complete && image.naturalWidth > 0);
  }, null, { timeout: 10_000 });
  await page.evaluate(title => { document.title = title; }, title);
  await page.bringToFront();
}

function pointIn(box, x = 0.5, y = 0.5) {
  return { x: box.x + box.width * x, y: box.y + box.height * y };
}

async function calibrate(page, nativeMouse) {
  const frame = await page.evaluate(() => ({ x: screenX, y: screenY,
    width: outerWidth, height: outerHeight }));
  const samples = [];
  for (const fraction of [0.35, 0.65]) {
    const point = pointIn(frame, fraction, fraction);
    await nativeMouse('move', [{ x: point.x - 16, y: point.y - 12 }], 0.12);
    await page.evaluate(() => { window.tinylensDemoPointer = null; });
    await nativeMouse('move', [point], 0.26);
    const screen = JSON.parse((await nativeMouse('position')).stdout);
    await until(() => page.evaluate(() => window.tinylensDemoPointer), 1300,
      `网页未收到系统光标事件 ${JSON.stringify({ frame, point, screen })}`);
    const pagePoint = await page.evaluate(async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return window.tinylensDemoPointer;
    });
    if (!pagePoint) throw new Error('网页未收到系统光标事件。');
    samples.push({ screen, page: pagePoint });
  }
  const [first, last] = samples;
  const scale = { x: (last.screen.x - first.screen.x) / (last.page.x - first.page.x),
    y: (last.screen.y - first.screen.y) / (last.page.y - first.page.y) };
  if (![scale.x, scale.y].every(value => value > 0.5 && value < 2) || Math.abs(scale.x - scale.y) > 0.06) {
    throw new Error(`桌面光标与网页坐标校准不一致 ${JSON.stringify({ frame, samples, scale })}`);
  }
  return point => ({ x: first.screen.x + (point.x - first.page.x) * scale.x,
    y: first.screen.y + (point.y - first.page.y) * scale.y });
}

async function rehearse(page, mouse, toScreen, caption = async () => {}) {
  async function aim(target, seconds, x, y) {
    const box = await target.boundingBox({ timeout: 1500 });
    if (!box) throw new Error('演示目标不在页面可见区域。');
    const point = pointIn(box, x, y);
    const screen = toScreen(point);
    await mouse('move', [screen], seconds);
    await until(() => target.evaluate((element, expected) => {
      const actual = window.tinylensDemoPointer;
      return document.hasFocus() && actual && Math.hypot(actual.x - expected.x, actual.y - expected.y) < 4
        && element.contains(document.elementFromPoint(actual.x, actual.y));
    }, point), 800, '光标未到达指定网页控件，已取消动作。');
    return { box, screen };
  }
  async function click(target, seconds) {
    const { screen } = await aim(target, seconds);
    await mouse('click', [screen]);
  }
  const plane = name => page.locator(`[data-plane="${name}"] .science-image-area`);
  const stages = page.locator('.stage-track .stage-step');
  const stageB = stages.filter({ has: page.locator('.step-dot', { hasText: /^B$/ }) });
  const canvas = page.locator('canvas.mask-canvas');
  const undo = page.getByRole('button', { name: '撤销 mask 编辑', exact: true });
  const mask = () => canvas.evaluate(element => element.toDataURL());
  const count = () => page.locator('.mask-pixel-count').innerText();
  const linked = minimum => page.evaluate(minimum => {
    const planes = [...document.querySelectorAll('[data-stage="m1"] .science-plane')];
    return planes.length === 6 && planes.every(plane => plane.querySelectorAll('.science-mapped-marker').length
      >= (plane.dataset.coordinateSpace === 'source' ? 1 : minimum));
  }, minimum);

  await delay(450);
  await caption('01  ·  M1 从像平面定位源位置');
  await aim(plane('observation'), 0.75, 0.70, 0.34);
  await until(() => linked(1), 900, '图像平面悬停没有同时显示六幅图的映射。');
  await delay(1150);
  await caption('02  ·  M1 从源平面查看对应的多重像');
  await aim(plane('source'), 0.80, 0.50, 0.50);
  await until(() => linked(2), 1100, '源平面悬停没有显示多重像对应位置。');
  await delay(1450);

  await caption('03  ·  切换到 B 阶段');
  await click(stageB, 0.65);
  await canvas.waitFor({ state: 'visible', timeout: 1500 });
  const before = await mask();
  const initialCount = await count();
  await delay(330);
  await caption('04  ·  用画笔增加掩膜区域');
  const { box, screen } = await aim(canvas, 0.60, 0.29, 0.67);
  await mouse('drag', [screen, toScreen(pointIn(box, 0.44, 0.72)),
    toScreen(pointIn(box, 0.60, 0.65))], 1.12);
  try {
    await until(() => undo.isEnabled(), 900, '掩膜笔画未提交到撤销历史。');
  } catch (error) {
    const gestures = await page.evaluate(() => window.tinylensDemoGestures.slice(-10));
    throw new Error(`${error.message} ${JSON.stringify({ initialCount, currentCount: await count(), gestures })}`);
  }
  const paintedCount = await count();
  if (paintedCount === initialCount || await mask() === before) throw new Error('笔画没有改变掩膜。');
  await delay(1050);
  await caption('05  ·  撤销，恢复原掩膜');
  await click(undo, 0.65);
  await until(async () => await mask() === before && await count() === initialCount, 900,
    '撤销后掩膜像素未恢复。');
  console.log(`已核对双向六图联动和掩膜撤销（${initialCount} → ${paintedCount} → ${initialCount}）。`);
}

function findControl(controls, names, role = 'AXButton') {
  return controls.find(control => control.enabled && control.role === role
    && control.names.some(name => names.includes(name)));
}

function recordly(driver) {
  const command = (action, fields = {}) => run(driver, [], {
    input: JSON.stringify({ action: `recordly-${action}`, ...fields }), timeout: 7000,
  });
  const controls = async () => JSON.parse((await command('controls')).stdout);
  const press = control => command('press', { names: control.names, role: control.role });
  const wait = (names, role, ms) => until(async () => findControl(await controls(), names, role), ms,
    `未找到 Recordly 控件（${names.join(' / ')}）。`);
  return { controls, press, wait, command };
}

const startNames = ['录制', 'Record', 'Start Recording'];
const stopNames = ['停止', '停止录制', 'Stop', 'Stop Recording', 'Stop recording'];

async function selectRecordlyWindow(recorder) {
  const controls = await recorder.controls();
  if (!findControl(controls, startNames)) throw new Error('请先将 Recordly 切换到空闲的录制工具栏。');
  if (!findControl(controls, ['启用麦克风', 'Enable Microphone', 'Enable microphone'], 'AXPopUpButton')
    || !findControl(controls, ['启用摄像头叠加', 'Enable Webcam Overlay', 'Enable webcam overlay'], 'AXPopUpButton')) {
    throw new Error('本次演示需要关闭 Recordly 的麦克风和摄像头。');
  }
  const source = controls.find(control => control.role === 'AXPopUpButton' && control.enabled);
  if (!source) throw new Error('Recordly 的录制来源选择器不可用。');
  await recorder.press(source);
  const target = await until(async () => {
    const matches = (await recorder.controls()).filter(control => control.role === 'AXButton'
      && control.enabled && control.names.some(name => name.includes(windowTitle)));
    if (matches.length > 1) throw new Error('Recordly 发现多个同名的 TinyLens 合成演示窗口。');
    return matches[0];
  }, 9000, 'Recordly 未找到 TinyLens 合成演示窗口。');
  await recorder.press(target);
  await until(async () => (await recorder.controls()).some(control => control.role === 'AXPopUpButton'
    && control.names.some(name => name.includes(windowTitle))), 3000,
  'Recordly 未确认选中 TinyLens 合成演示窗口。');
}

async function saveRecordlyVideo(recorder) {
  const saveName = await recorder.wait(['saveAsNameTextField'], 'AXTextField', 120_000);
  const location = (await recorder.controls()).find(control => control.names.includes('where popup'));
  if (!['下载', 'Downloads'].includes(location?.value)) throw new Error('Recordly 保存窗口的当前目录不是默认的下载目录。');
  // Recordly starts each MP4 save dialog in Downloads. Stage a uniquely named export there.
  const video = join(homedir(), 'Downloads', `TinyLens-recording-${randomUUID()}.mp4`);
  await recorder.command('value', { names: saveName.names, role: saveName.role, value: basename(video) });
  await recorder.press(await recorder.wait(['OKButton'], 'AXButton', 3500));
  let previousSize = 0;
  return until(async () => {
    const size = (await stat(video).catch(() => null))?.size ?? 0;
    const stable = size > 0 && size === previousSize;
    previousSize = size;
    return stable ? video : null;
  }, 20_000, `Recordly 未生成 MP4 ${video}`);
}

async function exportRecordly(recorder) {
  const exportButton = await recorder.wait(['导出', 'Export'], 'AXPopUpButton', 15_000);
  if (!findControl(await recorder.controls(), ['MP4'], 'AXCheckBox')) await recorder.press(exportButton);
  await recorder.press(await recorder.wait(['MP4'], 'AXCheckBox', 3500));
  const exportVideo = await recorder.wait(['导出Video', '导出视频', 'Export Video', '导出 MP4', 'Export MP4'], 'AXButton', 3500);
  await recorder.press(exportVideo);
  return saveRecordlyVideo(recorder);
}

async function recordDemoInBrowser(output) {
  if (!await demoResponds()) throw new Error('TinyLens 演示页未启动，请先运行 pnpm dev。');
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ executablePath: browserPath, headless: true, timeout: 10_000 });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, serviceWorkers: 'block',
    });
    await page.context().routeWebSocket('**/*', socket => socket.close());
    const encoder = process.env.TINYLENS_FFMPEG || (existsSync(ffmpeg) ? ffmpeg : 'ffmpeg');
    await prepareDemoPage(page, demoTitle);
    await page.evaluate(() => document.fonts.ready.then(() => {}));
    const mouse = browserMouse(page);
    const parking = await page.locator('[data-plane="observation"] figcaption').boundingBox();
    if (!parking) throw new Error('合成结果标题不可见。');
    const seconds = await capturePage(page, encoder, output, async caption => {
      await mouse('move', [pointIn(parking)]);
      await rehearse(page, mouse, point => point, caption);
    });
    console.log(`已保存 ${seconds.toFixed(2)} 秒浏览器演示 MP4\n${output}`);
  } finally {
    await browser.close();
  }
}

async function main() {
  if (process.argv[2] === '--help') {
    console.log('用法  scripts/record-demo.command [--browser] [输出.mp4]\n  --browser    在浏览器中直接录制合成交互样例');
    return;
  }
  const browserOnly = process.argv[2] === '--browser';
  const args = process.argv.slice(browserOnly ? 3 : 2);
  if (args.length > 1) throw new Error('只接受一个可选的 MP4 输出路径。');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = browserOnly ? 'TinyLens-网页演示' : 'TinyLens';
  const output = resolve(args[0] ?? join(projectRoot, 'artifacts/demo-recordings', `${name}-${stamp}.mp4`));
  if (!output.endsWith('.mp4') || existsSync(output)) throw new Error('请选择一个尚不存在的 .mp4 输出文件。');
  if (browserOnly) return recordDemoInBrowser(output);
  if (!browserPath || !existsSync(app) || !existsSync(ffmpeg)) {
    throw new Error('需要已安装的 Recordly 和 Microsoft Edge 或 Google Chrome。');
  }
  const work = await mkdtemp(join(tmpdir(), 'tinylens-demo-'));
  let browser, connection, vite, recorder;
  let captureRequested = false;
  let canceled = false;
  const cancel = () => {
    canceled = true;
  };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const modules = join(projectRoot, '.cache/tinylens-demo/swift-modules');
    await mkdir(modules, { recursive: true });
    const driver = join(work, 'mouse');
    await run('/usr/bin/swiftc', ['-module-cache-path', modules,
      fileURLToPath(new URL('demo-mouse.swift', import.meta.url)), '-o', driver], { timeout: 90_000 });
    await run(driver, [], { input: JSON.stringify({ action: 'check' }) });
    recorder = recordly(driver);
    await run('/usr/bin/open', ['-a', app]);
    await recorder.wait(startNames, 'AXButton', 6000);
    if (canceled) throw new Error('录制已取消。');

    if (!await demoResponds()) {
      const viteEntry = join(projectRoot, 'node_modules/vite/bin/vite.js');
      vite = spawn(process.execPath, [viteEntry, '--host', '127.0.0.1', '--port', '5173', '--strictPort'],
        { cwd: projectRoot, stdio: 'ignore' });
      await until(demoResponds, 10_000, 'TinyLens 合成演示服务未启动。');
    }
    const profile = join(work, 'browser');
    browser = spawn(browserPath, [`--user-data-dir=${profile}`, '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check',
      '--disable-sync', '--disable-extensions', '--app=about:blank',
      '--window-position=12,32', '--window-size=1440,900'], { stdio: 'ignore' });
    const opened = await openDemo(browser, profile);
    connection = opened.connection;
    const { page } = opened;
    const nativeMouse = (action, points, seconds) => {
      if (canceled) throw new Error('录制已取消。');
      return run(driver, [], { input: JSON.stringify({ action, pid: browser.pid, points, seconds }), timeout: 5000 });
    };
    await page.bringToFront();
    await nativeMouse('activate');
    const toScreen = await calibrate(page, nativeMouse);
    const parking = await page.locator('[data-plane="observation"] figcaption').boundingBox();
    if (!parking) throw new Error('合成结果标题不可见。');
    await nativeMouse('move', [toScreen(pointIn(parking))], 0.20);
    await selectRecordlyWindow(recorder);
    await page.bringToFront();
    await nativeMouse('activate');
    await page.evaluate(title => { document.title = title; }, demoTitle);
    console.log(`用 Recordly 录制约 ${recordSeconds} 秒的合成演示窗口。`);
    await recorder.press(await recorder.wait(startNames, 'AXButton', 3500));
    captureRequested = true;
    await recorder.wait(stopNames, 'AXButton', 20_000);
    const started = performance.now();
    await page.bringToFront();
    await nativeMouse('activate');
    await rehearse(page, nativeMouse, toScreen);
    await delay(Math.max(0, started + recordSeconds * 1000 - performance.now()));
    await recorder.press(await recorder.wait(stopNames, 'AXButton', 2500));
    captureRequested = false;
    if (canceled) throw new Error('录制已取消。');
    console.log('Recordly 正在导出 MP4。');
    const rendered = await exportRecordly(recorder);
    const { stderr } = await run(ffmpeg, ['-hide_banner', '-nostdin', '-i', rendered, '-an', '-f', 'null', '-'],
      { timeout: 45_000 });
    const duration = stderr.match(/Duration: (\d+):(\d+):([\d.]+)/);
    const seconds = duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : 0;
    if (seconds < 10 || seconds > 15) throw new Error(`MP4 时长 ${seconds} 秒，超出要求的 10–15 秒。`);
    await mkdir(dirname(output), { recursive: true });
    await copyFile(rendered, output, constants.COPYFILE_EXCL);
    await unlink(rendered);
    console.log(`已保存 ${seconds.toFixed(2)} 秒 MP4\n${output}`);
  } finally {
    if (captureRequested) {
      const controls = await recorder.controls().catch(() => []);
      const stop = findControl(controls, [...stopNames, '取消', 'Cancel']);
      if (stop) await recorder.press(stop).catch(() => {});
    }
    await connection?.close().catch(() => {});
    for (const child of [browser, vite]) await stopOwned(child);
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    await rm(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

export { recordly, saveRecordlyVideo };
