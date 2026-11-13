# TinyLensWeb

面向强引力透镜建模的桌面 Web 工作台，使用 React、TypeScript 和 Vite。它把输入图像、各阶段诊断、参数后验、mask 编辑和 AI 对话放在同一界面，通过本机桥接服务连接 GPU 服务器上的 Codex agent pipeline。

本仓库补齐了 [TinyLensGpu](https://github.com/caoxiaoyue/TinyLensGpu) **没有提供的 Web 前端、通讯服务和 `lens_agent` 编排源码**。TinyLensGpu 仍作为独立的科学计算依赖安装。你需要提供自己的观测数据、GPU 环境及 AI 账号或 API；仓库不包含作者的 API key、私人服务地址、服务器登录、AI 会话、科研输入或运行结果。

当前支持桌面浏览器。真实工作台按 D（预检）、A、B、M0、M1、M2、M3 组织；Web 与合成演示共用 Stage 布局。macOS 客户端尚未实现。

## 1. 仓库里有什么

```text
TinyLensWeb/
├── src/                     # React 工作台、数值图像显示、参数与消息交互
├── public/demo/             # 确定性合成演示素材，与真实运行隔离
├── server/                  # SSH / Codex app-server 桥接与受限只读产物读取
├── pipeline/
│   ├── src/lens_agent/      # 阶段执行、配置、审查、接受头与结果管理
│   ├── .codex/agents/       # 九个科学角色；模型 ID 由用户配置
│   ├── .codex/skills/       # lens-model-orchestrator 及阶段审查规则
│   ├── .codex/evals/        # 响应 schemas、评测定义及说明
│   ├── scripts/             # GPU runner 与独立批处理入口
│   ├── docs/                # 科学工作流与实现决策
│   └── tests/               # Pipeline 回归测试
├── scripts/
│   ├── configure_agents.py  # 填写用户自己的模型 ID / reasoning effort
│   ├── prepare_input.py     # 无损封装 FITS 与 Web 输入清单
│   └── doctor.mjs           # 连接与依赖检查，不启动 AI 回合或科学阶段
├── config/                  # SSH、AI provider 与启动包装器示例
├── tests/                   # 前端测试、只读数值夹具、输入封装测试
└── .env.example             # 本机桥接配置，不存放 AI 密钥
```

`pipeline/` 是科学工作流的根目录；外层是整个 Web 项目的 Git 根目录。服务器上的输出必须位于 `pipeline/output/`，以符合 Web 产物通道的读取边界。

## 2. 先运行合成演示

需要 Node.js **22.12+**、pnpm **10.11.0**。仅查看演示不需要 Python、GPU、SSH 或 AI API。

```bash
git clone https://github.com/asOrangee/TinyLensWeb.git
cd TinyLensWeb
corepack enable
corepack prepare pnpm@10.11.0 --activate
pnpm install --frozen-lockfile
pnpm dev
```

打开 [中文合成演示](http://127.0.0.1:5173/?mode=demo&design=studio) 或 [英文合成演示](http://127.0.0.1:5173/?mode=demo&design=studio&lang=en)。演示中的图像、后验、任务和 mask 都是合成数据或浏览器本地交互，不能当作真实科学结果。

生产构建与本机预览：

```bash
pnpm build
pnpm preview --port 5173
```

真实联调也请使用 5173 端口；桥接服务的本机来源校验固定允许该 Web 端口。普通 `pnpm preview` 的默认 4173 端口仅适合演示查看。

### 录制合成交互演示

运行 `pnpm dev` 后，可用 Playwright 和支持 `libx264` 的 FFmpeg 录制合成工作台。安装 Playwright 并准备 Edge、Chrome 或 Playwright 自带的 Chromium，然后在项目目录运行：

```bash
node scripts/record-demo.mjs --browser
```

录制展示 M1 的双向平面联动、B 的掩膜绘制和撤销，默认保存到 `artifacts/demo-recordings/`。可追加一个尚不存在的 `.mp4` 路径，并用 `TINYLENS_FFMPEG` 指定编码程序。macOS 上也可运行 `scripts/record-demo.command` 使用 Recordly 录制。

## 3. 安装 GPU 服务器上的科学环境

推荐 Linux NVIDIA GPU 服务器，安装 SSH、Git、Conda、Bash 4+，以及 `flock`、`setsid`、`timeout`、`realpath`、`nvidia-smi`。工作站只运行浏览器、Node 和 SSH；科学环境留在服务器。

把本仓库也放到 GPU 服务器，例如 `/srv/TinyLensWeb`。下列路径是示例，请按自己的权限和目录替换。

```bash
conda create -n tinylens_gpu python=3.11 -y
conda activate tinylens_gpu

# 已有 TinyLensGpu 源码时可使用现有副本；为复现本接口，建议使用下列版本。
git clone https://github.com/caoxiaoyue/TinyLensGpu.git
cd TinyLensGpu
git checkout c3c8f9d88e6917f9366917b418fcd3335d72e6b8
python -m pip install -r requirements.txt
python -m pip install -e .

cd /srv/TinyLensWeb
python -m pip install -e ./pipeline
python -m pip install -r requirements-display.txt
python -m pip check
python -m lens_agent.cli --help
```

`config/science-constraints.txt` 记录原开发环境的关键 Python 版本，可在安装时通过 `-c config/science-constraints.txt` 使用；它不包含 CUDA 驱动，且不是所有操作系统的安装锁。

`config/TinyLensGpu.revision` 记录接口开发所使用的上游版本；它与上游最新分支可能不同。更换上游版本前，需验证 pipeline 和只读模型重建调用的接口。CUDA/JAX 安装以 [TinyLensGpu 安装说明](https://github.com/caoxiaoyue/TinyLensGpu#installation) 为准；库能导入不等于 GPU 环境已可用。

`nvidia-smi` 必须能可靠返回真实设备状态。GPU runner 默认使用系统 NVML 库；确有驱动兼容需要时，由管理员设置 `GPU_QUERY_LD_LIBRARY_PATH`，仓库不附带机器专用驱动库。默认空闲条件为已用显存 ≤2000 MiB、利用率 ≤10%，并使用同用户 GPU 文件锁；查询失败不会视为 GPU 空闲。

## 4. 配置自己的 AI

目前实现的 AI 传输层是 **Codex app-server**。你可以使用自己的 Codex 登录，也可以在远程 Codex 的用户配置中接入自己的 provider。自定义 provider 需要支持 Codex 使用的 Responses 协议、工具调用、图片输入及科学工作流所需的多 agent 能力；填写任意聊天 API 地址并不保证兼容。

在 GPU 服务器安装 Codex CLI，并确认这些命令可用：

```bash
codex --version
codex app-server --help
```

桥接使用实验性 app-server 协议（动态报告工具、线程、子线程审批及分页恢复）。不同 Codex 版本可能有协议差异，不能仅凭 CLI 版本号断言兼容。参考 [Codex App Server](https://learn.chatgpt.com/docs/app-server)。

**方案 A：使用自己的 Codex 登录。** 在 GPU 服务器按照 CLI 登录流程登录，然后让 SSH 启动的同一用户使用该登录。不要复制其他人的 `auth.json`。

**方案 B：使用自己的 API。** 将 [provider 模板](config/codex-provider.toml.example) 的内容合并到 GPU 服务器自己的 Codex 用户配置中（通常为 `~/.codex/config.toml`），填写自己的模型 ID 和 API base URL。`env_key = "TINYLENS_API_KEY"` 指向保存密钥的环境变量；不要把密钥写进 TOML、前端或 Git。字段含义见 [官方配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。

SSH 非交互命令不一定读取交互 shell 的环境变量。可以使用 [远程启动包装器模板](config/remote-codex.example.sh)，填写 Codex 程序、独立 `CODEX_HOME` 和服务器上的私有密钥文件路径，再将 `.env.local` 的 `TINYLENS_REMOTE_CODEX` 指向该包装器。密钥文件只包含你自己的 key，由你在服务器本地建立并限制读取权限；无需发给 Web。包装器的实际副本和密钥文件都不应进入仓库。

不使用 API 密钥时，直接将 `TINYLENS_REMOTE_CODEX` 指向真正的 Codex 程序，包装器并非必需。独立 `CODEX_HOME` 需要完成自己的登录或 provider 配置，不能指向空目录后期望继承其他目录的登录。

还需配置九个科学角色使用的模型。在 GPU 服务器的仓库根目录执行：

```bash
python scripts/configure_agents.py --model 'YOUR_ACTUAL_MODEL_ID' --effort medium
# 可选：给预检与综合专家指定另一模型
# python scripts/configure_agents.py --model 'YOUR_STAGE_MODEL_ID' \
#   --review-model 'YOUR_INSPECTOR_MODEL_ID' --effort medium
```

脚本仅填写角色文件的模型和 reasoning effort，不改科学提示词、接受门槛或 API 凭据。随仓库提供的 `YOUR_MODEL_ID` 是必须替换的占位符。主编排模型由你自己的 Codex 用户配置选择；角色模型也应是同一 provider 允许的模型。

## 5. 连接本机 Web 与 GPU 服务器

在运行 Web 的电脑自己的 `~/.ssh/config` 中增加连接别名，参考 [SSH 配置模板](config/ssh-config.example)：

```sshconfig
Host tinylens-gpu
    HostName YOUR_GPU_HOST
    User YOUR_USERNAME
    Port 22
    IdentityFile ~/.ssh/YOUR_PRIVATE_KEY
```

先由你完成首次 SSH 登录及服务器指纹核验，确认 `ssh tinylens-gpu` 可以连接。桥接随后使用 `BatchMode=yes`，不会在网页收集密码。

在本机仓库根目录建立配置：

```bash
cp .env.example .env.local
```

编辑 `.env.local`，至少核对以下字段。路径都是 **GPU 服务器上的绝对路径**：

| 配置项 | 作用 |
| --- | --- |
| `TINYLENS_SSH_HOST` | 自己的 SSH 别名，默认 `tinylens-gpu` |
| `TINYLENS_REMOTE_WORKSPACE` | 服务器本仓库中的 `pipeline/` 目录 |
| `TINYLENS_REMOTE_PYTHON` | 安装了 TinyLensGpu、lens_agent 和显示依赖的 Python 程序 |
| `TINYLENS_REMOTE_CODEX` | 服务器 Codex 程序或自己的启动包装器 |
| `TINYLENS_REMOTE_CODEX_HOME` | 可选的远程 Codex 用户配置目录 |
| `TINYLENS_DATASET_PATH` | 可选的初始输入目录；新任务也可在对话中指定数据 |

真实结果读取器也使用同一组 SSH/Python 配置。`.env.local` 由 Node 服务读取，不会编译进浏览器；修改后需重启自己的桥接进程。

```bash
pnpm doctor
pnpm doctor --remote
# 分别在两个终端运行
pnpm agent:server
pnpm dev
```

`doctor --remote` 只检查 SSH、依赖导入、角色占位符、Codex 版本和 app-server 帮助；不调用 AI、不验证模型服务可用性，也不启动 GPU 阶段。服务默认分别监听 `127.0.0.1:5184` 和 `127.0.0.1:5173`，不包含公网多用户部署的认证层。

打开 [真实 AI 工作台](http://127.0.0.1:5173/?design=studio)。首次任务没有作者的旧消息和结果；通过左栏新建任务，在对话中明确给出输入、输出目录及运行要求。仅打开页面、创建任务或切换任务不会启动科学计算；发送运行要求后，执行仍由 pipeline AI 决定。

默认让 GPU 服务器直接访问你自己的模型服务。如确需通过本机已有 HTTP 代理访问官方 OpenAI 服务，可设置 `TINYLENS_AI_NETWORK=loopback-proxy` 和 `TINYLENS_PROXY_PORT`。该可选通道使用临时认证，默认由 SSH 分配服务器回环端口，仅允许列出的官方域名。已有部署可继续用 `TINYLENS_REMOTE_PROXY_PORT` 指定固定端口。自定义 provider 使用服务器自己的网络通道。

## 6. 准备自己的图像

底层 pipeline 输入为 `<lens_id>/<lens_id>.fits`，扩展必须包含 `VIS_FLUX`、`VIS_RMS`、`VIS_PSF`。`VIS_RMS` 是严格为正的 **1σ RMS**，不是 inverse variance、权重图或方差。图像与噪声需同形，PSF 需同采样；当前几何适配支持方形、轴对齐、等像素尺度的图像及独立轴翻转。

Web 的输入与模型查看还需要相邻的 `input-provenance.json`。在服务器上运行随仓库补齐的封装工具，例如：

```bash
cd /srv/TinyLensWeb
python scripts/prepare_input.py \
  --lens-id lens-001 \
  --image /path/to/image.fits --noise /path/to/rms.fits --psf /path/to/psf.fits \
  --pixel-scale-arcsec 0.05 \
  --input-x-direction increasing --input-y-direction decreasing \
  --geometry-evidence 'Replace with the verified calibration and axis convention for these data.'
```

这只是一个以 **0.05″/pixel** 为例的命令，必须用自己的标定与方向替换。多扩展输入可用 `--fits /path/to/lens.fits` 替代三个分文件参数；分文件可用 `--image-hdu`、`--noise-hdu`、`--psf-hdu` 指定数组所在的 HDU，默认 0。

工具把原始数组原值写到新的 `pipeline/output/inputs/lens-001/`，记录原文件与封装 FITS 的 SHA-256，并建立已明确声明的中心局部坐标头。它不从天球 WCS 推断方向，不重采样、不翻转数组、不归一化 PSF，也不更改原始文件。已存在的目标目录会被拒绝。输入清单沿用现有协议名 `mock_input_provenance.v1`，这个名字不表示真实观测被当作合成数据。预览当前最多支持每轴 512 像素及 16 MiB 的封装 FITS。

旋转/剪切 WCS、不等像素尺度、非方形图像、不同采样 PSF 及未配准波段需另行准备；不能通过填写几何参数来替代重投影或科学数据处理。一次运行的输入标定从预检起冻结，更正标定要新建运行并保留旧结果。

## 7. 向 AI 提交真实任务

以下是需要你核对并主动发送的普通用户消息示例。替换路径、镜像标识及标定说明；只有准备执行真实科学计算时才发送：

```text
请使用 lens-model-orchestrator 工作流分析 lens-001。
Repository Root: /srv/TinyLensWeb/pipeline
Input Directory: /srv/TinyLensWeb/pipeline/output/inputs
Lens IDs: lens-001
Batch Output Directory: /srv/TinyLensWeb/pipeline/output/run-001
Lens Result Directory: /srv/TinyLensWeb/pipeline/output/run-001/lens-001
Lens Agent Command: /opt/conda/envs/tinylens_gpu/bin/python -m lens_agent.cli
GPU Stage Command: /srv/TinyLensWeb/pipeline/scripts/run_lens_stage_on_idle_gpu.sh --python /opt/conda/envs/tinylens_gpu/bin/python

请先核验 input-provenance.json、原始图像和输入标定；本例为 0.05 arcsec/pixel，x 随列递增、y 随行递减，请核对后用于预检并冻结。按照现有工作流进行三名 Inspector、综合判断、A、B、M0、M1、M2、M3 及科学审查。不要修改 pipeline 源码、科学门槛或原始输入；保留已有结果，遇到待答问题或命令审批时等待我的真实选择。

请用 tinylens_ui_report 明确报告阶段状态，并逐项报告 input-provenance.json、preflight/inspector.json、各阶段 stage-result.json 及存在的 PKL 产物。只有你核验正式接受头后才报告接受；没有的结果不要补造。
```

Stage A 的标准 runner 还需按工作流添加 `--timeout-seconds 1800`；由 AI/阶段专家按现有规则构造实际阶段命令，前端不拼装或调用科学 CLI。原科学角色在运行期间默认使用英文，若希望中文回复，可在普通消息中提出；Web 不覆盖其永久指令。

阶段计算成功、AI 回合结束、生成诊断图、硬门槛通过和科学接受是不同状态。Web 仅显示 AI 明确报告且通过受限读取器核验的产物。缺少结果显示“—”；B 不显示虚构后验，M0 的证据扫描不作为归一化后验；参数中心值 q50 是带权中位数，不标为最大似然“最优值”。

新建任务后，输入框位于欢迎页中央。发送首条消息后进入 Stage 工作台。任务可从当前浏览器的侧栏移入“已删除任务”，也可从该列表恢复。切换 Stage 时保留可用页签与当前任务的色阶，可选 Linear、Log、Asinh 和 Z。

A、M0、M1、M2 和 M3 可用已报告的数值产物展示六幅诊断图。M3 使用同一 attempt 的 EPL＋外剪切结果提供双向平面联动、临界线和焦散线。参数页保留采样参数与线性求解量的卡片，M0 显示扫描选定值和相对对数证据曲线。

真实 B mask 编辑只保存本地草稿，并以普通用户输入交给 AI；不直接写回运行中的 FITS。重跑请求同样交给 AI，不能因点击界面或消息送达而视为执行、覆盖或接受完成。位置约束点选也不保证当前 pipeline 已将该约束应用于拟合。

## 8. 测试与当前边界

```bash
pnpm build
pnpm test:frontend
pnpm test:agent

# 安装 Python 测试依赖后，验证无损输入封装
python -m pip install -r requirements-test.txt
python -m pytest -q tests/test_prepare_input.py

# 在已安装 TinyLensGpu 的 Linux 科学环境运行 pipeline 的 CPU 回归
cd pipeline
CUDA_VISIBLE_DEVICES= JAX_PLATFORMS=cpu python -m pytest -q
```

部分通讯数值测试需要 Python 的 NumPy/Pillow；可用 `TINYLENS_RESULT_TEST_PYTHON=/absolute/path/to/python` 指定。缺少依赖时会明确跳过，跳过不能算通过。通讯测试使用模拟 AI，不提交真实任务或审批；Pipeline CPU 回归也不等于真实样本 A–M3 运行及科学接受。

评测定义保留了原科学工作流的 schema 和案例说明；原始评测观测图像及真实运行目录不随发布包分发。离线 schema/合成测试可用，面向观测样本的 AI 评测需要自行提供对应图像/结果，并更新 manifest 与哈希。详见 [评测说明](pipeline/.codex/evals/README.md)。

九个角色的工作流和科学规则随源码提供；其中阶段执行角色沿用 pipeline 的 `danger-full-access` 配置，真实运行前应在自己的执行环境核对角色权限和命令审批机制。前端自身不自动批准问题或命令，不把一次批准扩大为长期权限。

## 9. 常见问题

| 现象 | 检查位置 |
| --- | --- |
| 演示能打开，真实页连接失败 | 确认桥接 5184、SSH 别名、远程工作目录、Codex 程序和自己的登录 |
| `python3`/`codex` 不存在 | 为 `.env.local` 填写服务器上的绝对程序路径；非交互 SSH 不一定加载 Conda/PATH |
| 没有输入图像 | 先封装输入，再让 AI 显式报告 `input-provenance.json`；只报告一张诊断 PNG 不足以显示数值图位 |
| 某阶段图位为空 | 核对同一会话是否已报告对应 summary/PKL、冻结依赖和输入；不要用演示图替代 |
| `YOUR_MODEL_ID` 错误 | 执行 `scripts/configure_agents.py`，同时核对主 Codex 配置及 provider 支持的模型 |
| API 在交互 shell 可用，Web 不可用 | 检查 SSH 启动环境、私有 key 文件及包装器；不要把 key 放入 `VITE_*` |
| `No idle unlocked GPU is available` | runner 正按现有门槛等待；不会自动放宽资源门槛或把查询错误当作空闲 |
| 重新打开页面后未继续运行 | 恢复连接与恢复科学执行是不同操作；查看已有报告后向 AI 明确提出恢复要求，避免重复运行 |

不要上传 `.env.local`、Codex 登录、SSH 私钥、代理凭据、`.local/`、`pipeline/dataset/` 或 `pipeline/output/`。本仓库使用新的 Git 历史，只纳入可分发的源码、模板、测试和合成演示素材。

TinyLensGpu 及其版权/许可属于原作者，STCI 派生显示代码的许可随源码保留，见 [第三方说明](THIRD_PARTY_NOTICES.md)。
