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
git checkout 80016a8fef292d24c7fb746269b44a77e94daa3f
python -m pip install -r requirements.txt
python -m pip install -e .

cd /srv/TinyLensWeb
python -m pip install -e ./pipeline
python -m pip install -r requirements-display.txt
python -m pip check
python -m lens_agent.cli --help
```

`config/science-constraints.txt` 记录原开发环境的关键 Python 版本，可在安装时通过 `-c config/science-constraints.txt` 使用；它不包含 CUDA 驱动，且不是所有操作系统的安装锁。

`config/TinyLensGpu.revision` 记录包含像素化非负 FISTA 求解器的已验证上游版本。更换上游版本前，需验证 pipeline 和只读模型重建调用的接口。CUDA/JAX 安装以 [TinyLensGpu 安装说明](https://github.com/caoxiaoyue/TinyLensGpu#installation) 为准；库能导入不等于 GPU 环境已可用。

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

新建和恢复任务默认用中文答复，主控和九个科学角色使用 `gpt-6.1-sol`、`max` 和 Fast（`priority`）。命令和访问请求默认交给 Codex 的「帮我批准」按风险审查。设置随源码分发，部署需要支持这些选项的 Codex 和相应的模型访问权限。

如需为科学角色指定其他模型，可在 GPU 服务器的仓库根目录执行：

```bash
python scripts/configure_agents.py --model 'YOUR_ACTUAL_MODEL_ID' --effort medium
# 可选：给预检与综合专家指定另一模型
# python scripts/configure_agents.py --model 'YOUR_STAGE_MODEL_ID' \
#   --review-model 'YOUR_INSPECTOR_MODEL_ID' --effort medium
```

脚本填写角色文件的模型和推理强度。角色服务层级由各自的 TOML 文件设置，主控设置可在桥接的 `.env.local` 中覆盖。

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
| `TINYLENS_AI_MODEL` | 主控模型，默认 `gpt-6.1-sol` |
| `TINYLENS_AI_REASONING_EFFORT` | 主控推理强度，默认 `max` |
| `TINYLENS_AI_SERVICE_TIER` | 主控服务层级，默认 `priority`（Fast） |
| `TINYLENS_APPROVALS_REVIEWER` | 审批方式，默认 `auto_review`（帮我批准）。设为 `user` 可手动审批 |
| `TINYLENS_DATASET_PATH` | 可选的初始输入目录；新任务也可在对话中指定数据 |

真实结果读取器也使用同一组 SSH/Python 配置。`.env.local` 由 Node 服务读取，不会编译进浏览器；修改后需重启自己的桥接进程。

```bash
pnpm doctor
pnpm doctor --remote
# 分别在两个终端运行
pnpm agent:server
pnpm dev
```

`doctor --remote` 检查 SSH、依赖导入、远程 Python 实际加载的 Pipeline Release 与 M0 网格策略、角色占位符、Codex 版本和 app-server 帮助。检查不调用 AI、不验证模型服务可用性，也不启动 GPU 阶段。服务默认分别监听 `127.0.0.1:5184` 和 `127.0.0.1:5173`，不包含公网多用户部署的认证层。

打开 [真实 AI 工作台](http://127.0.0.1:5173/?design=studio)。首次任务没有作者的旧消息和结果；通过左栏新建任务，在对话中明确给出输入、输出目录及运行要求。仅打开页面、创建任务或切换任务不会启动科学计算；发送运行要求后，执行仍由 pipeline AI 决定。

收到建模指令并确定目标后，Pipeline AI 通过 `tinylens_ui_report` 提交简短任务名，例如 `SDSSJ0946`。本机桥接在任务自己的状态目录登记 `task-name.json`，并通过同一个任务列表为左侧菜单和顶部标题供名。展开左侧菜单后可手动改名，手动保存的名称优先。

默认让 GPU 服务器直接访问你自己的模型服务。如确需通过本机已有 HTTP 代理访问官方 OpenAI 服务，可设置 `TINYLENS_AI_NETWORK=loopback-proxy` 和 `TINYLENS_PROXY_PORT`。该可选通道使用临时认证，默认由 SSH 分配服务器回环端口，仅允许列出的官方域名。已有部署可继续用 `TINYLENS_REMOTE_PROXY_PORT` 指定固定端口。自定义 provider 使用服务器自己的网络通道。

## 6. 准备自己的图像

底层 pipeline 输入为 `<lens_id>/<lens_id>.fits`，扩展必须包含 `VIS_FLUX`、`VIS_RMS`、`VIS_PSF`。`VIS_RMS` 是严格为正的 **1σ RMS**，不是 inverse variance、权重图或方差。图像与噪声需同形，PSF 需同采样；当前几何适配支持方形、轴对齐、等像素尺度的图像及独立轴翻转。

Web 通过 `input-provenance.json` 校验封装输入。数据预览也能从 AI 已报告的预检记录或登记的诊断图定位同次运行清单，再找到其中绑定的输入；同时支持记录了 `VIS_FLUX` 与 `VIS_BGSUB` 别名及数组校验值的 Euclid 输入。在服务器上可用随仓库提供的封装工具准备输入，例如：

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

请先核验 input-provenance.json、原始图像和输入标定。本例为 0.05 arcsec/pixel，x 随列递增、y 随行递减，请核对后用于预检并冻结。按照现有工作流进行三名 Inspector、综合判断、A、B、M0、M1、M2、M3 及科学审查。保留 pipeline 源码、科学门槛、原始输入和已有结果。遇到需要用户决策的科学问题时，等待我的答复。

请用 tinylens_ui_report 明确报告阶段状态。用 tinylens.stage-report.v1 携带原始 run_path、run-manifest.json 中的 run_id、lens_id、stage、attempt（预检填 null）。执行和科学审查分别用 running、awaiting_review、reviewing、accepted 等状态。核验正式接受头后再报告 accepted。展示清单可通过 display_manifest 明确报告。整体重跑归档时，请用该次旧 run_id 和原始 run_path 报告归档后的 run-manifest.json，kind=artifact、stage=preflight、attempt=null。旧运行仍可报告明确的阶段产物及相应状态。
```

Stage A 的标准 runner 还需按工作流添加 `--timeout-seconds 1800`。AI 和阶段专家按现有规则构造阶段命令。面向用户的进度、提问和总结默认使用中文，用户可以在对话中指定其他回复语言。科学文件中的字段、枚举和参数名按各自的格式保存。

阶段计算成功、AI 回合结束、生成诊断图、硬门槛通过和科学接受是不同状态。Web 仅显示 AI 明确报告且通过受限读取器核验的产物。缺少结果显示“—”；B 不显示虚构后验，M0 的证据扫描不作为归一化后验；参数中心值 q50 是带权中位数，不标为最大似然“最优值”。

新建任务后，输入框位于欢迎页中央。发送首条消息后进入 Stage 工作台。任务可从当前浏览器的侧栏移入“已删除任务”，也可从该列表恢复。选择“彻底删除”后，先核对 GPU 服务器上的结果目录，再确认清理结果和本地任务记录、会话日志、预览缓存及当前浏览器的草稿。原始观测、共享或身份未经核验的结果以及远程 Codex 会话会保留。仍在运行或等待确认的任务需要先结束当前回合。切换 Stage 时保留可用页签与当前任务的色阶，可选 Linear、Log、Asinh 和 Z。

AI 正在运行时，输入补充内容并点击发送箭头或按 Enter，消息会作为引导交给当前回合。输入框为空时，方块用于停止当前回合。如果发送时回合已结束，输入框会保留草稿。

#### 在对话框提交建模批次

升级 Web 和 AI 桥接后，在真实工作台新建一个普通任务，让 Pipeline AI 在新会话里载入批次工具。用自然语言说明想跑哪些目标、数据在哪里，以及结果放到哪里。

```text
请把 /data/lenses 中按 ID 排序的前 100 个 lens 分开建模，结果写到
/srv/TinyLensWeb/pipeline/output/batch-01。已有运行就继续，自动并发上限设为 4。
```

1. 使用 GPU 服务器上的实际绝对路径。输入按 `<lens_id>/<lens_id>.fits` 组织，结果目录位于配置的 `TINYLENS_REMOTE_WORKSPACE/output` 下。可以在对话里给 ID 清单、ID 前缀、按 ID 取前 N 个的规则，以及数据的输入标定。
2. Pipeline AI 会追问缺失信息，并在对话里展示核验过的目标名单、结果目录，以及各目标的新建或继续状态。要调整名单或并发，在同一对话里说明。
3. 核对后回复「确认提交这批」。AI 会将这个名单交给队列，每个 lens 有独立任务和 `<结果目录>/<lens_id>` 结果路径。已有运行按其运行标识继续。
4. 从对话的「查看批次进度」或侧栏「批次进度」查看各 lens 的阶段、科学问题和审批。暂停派发会保留待启动的队列，已经派发的任务继续运行。

自动派发上限默认是 4，可填 1–16。计算阶段使用现有 runner 按需申领空闲 GPU，实际并行数取决于空闲设备和当前阶段。需你答复的任务等待各自会话里的决定。批次与派发记录保存在本机桥接的 `.local/`，关网页后继续派发。桥接重启后恢复队列并核对已送达的任务，送达有疑问时可打开任务检查原会话。进度里「已接受」与「人工审查」来自核验过的科学记录。

A、M0、M1、M2 和 M3 的结果预览上排为 Data image、Model image、Normalized residual，下排为 Lens light、Lensed source、Unlensed source。Lens light 和 Lensed source 与 Data image 共用色标上下限和拉伸方式。Lensed source 只显示该次已核验的拟合像素。M3 使用同一 attempt 的 EPL＋外剪切结果提供双向平面联动、临界线和焦散线。参数页保留采样参数与线性求解量的卡片，M0 显示扫描选定值和相对对数证据曲线。

#### 阶段展示文件

新结果每张图对应一个 `StageName_ImageName.fits`，文件名区分大小写。Pipeline 和 Web 桥接共用 `pipeline/src/lens_agent/display_contract.json`，FITS 主 HDU 存放二维数值并记录像素几何。相对于 `output/<RunID>/<LensID>/` 的目录及文件如下。

| 阶段 | 目录 | FITS 文件名 |
| --- | --- | --- |
| Data Preview | `preflight/display/` | `DataPreview_DataImage.fits`、`DataPreview_NoiseImage.fits`、`DataPreview_SNRImage.fits`、`DataPreview_PSFImage.fits` |
| B | `attempts/b/<Attempt>/display/` | `StageB_DataImage.fits`、`StageB_LensedSource.fits`、`StageB_ArcMask.fits`、`StageB_ValidDomain.fits` |
| A、M0、M1、M2、M3 | `attempts/<Stage 小写>/<Attempt>/display/` | `<StageName>_DataImage.fits`、`<StageName>_ModelImage.fits`、`<StageName>_LensLight.fits`、`<StageName>_LensedSource.fits`、`<StageName>_UnlensedSource.fits`、`<StageName>_NormalizedResidual.fits`、`<StageName>_ChiSquare.fits`。`<StageName>` 为 `StageA` 或 `StageM0` 至 `StageM3`。 |

预检噪声图为 1σ RMS。B 的 `ArcMask` 和 `ValidDomain` 中 1 表示纳入，`LensedSource` 取自该次 B 实际依赖的 A。上游历史 attempt 缺少可核验的源图时，B 仍可展示 mask。A、M0–M3 的源平面保留独立边界。像素化模型用该次求得的源像素做同一算子的全网格投影，并对照原拟合区保存的预测。历史展示包缺少 Lens light 文件时，桥接可读取本次模型实际使用的、可核验的 Stage A 透镜光数组。

每个建模 attempt 的 `display/` 还发布独立的 mask 图层。固定文件名是 `<StageName>_ApertureMask.fits`、`<StageName>_ContaminationMask.fits` 和 `<StageName>_ArcMask.fits`。三个文件分别用 1 表示圆内、污染像素和纳入弧区。Stage A 发布前两层，B 复用它已有的 `StageB_ArcMask.fits`，M0–M3 的弧区取自该次拟合依赖的 B attempt。展示清单的 `mask_layers` 记录文件路径和哈希，桥接核验像面几何后逐层提供给网页。缺少可核验证据的图层留空。`ValidDomain` 继续记录实际参与拟合的像素。

每个阶段在同一个 `display/` 中写出 `StageName_Parameters.json`。预检使用 `DataPreview_Parameters.json`，A、B 和 M0–M3 分别使用 `StageA_Parameters.json`、`StageB_Parameters.json` 和 `StageM0_Parameters.json` 至 `StageM3_Parameters.json`。文件由 Pipeline 按 `tinylens.stage-parameters.v1` 写出，记录本次配置、统计量、实际固定值和可用的线性解。采样阶段保存带权边缘后验直方图和 q16、q50、q84。中心值为 q50，下误差为 q50−q16，上误差为 q84−q50。M0 保存粗、细证据扫描及选中的 `log_lambda_reg`。预检和 B 保存实际配置与统计量。

`display-manifest.json` 位于 `display/` 的同级目录，绑定 run、Stage、attempt、上游 attempt 和文件哈希。桥接按 AI 报告核验，并从已核验的固定文件向网页分别提供图像与参数。某类文件缺失时，另一类已核验的内容仍可展示。原始诊断图供后端审查。预检命令输出清单和目录，建模结果包含 `display_manifest` 和 `display_directory`。

A、M0–M3 在 `display/` 发布 `StageName_LensMapping.json`，例如 `StageM3_LensMapping.json`。Pipeline 使用该 attempt 绘图时的质量模型和原始像平面视野，从 TinyLensGpu 计算临界曲线，并逐点映到源平面得到焦散线。文件记录成对的曲线坐标、参考射线、模型参数以及两平面的 FITS 几何。网页绘制保存的曲线，双向鼠标联动使用同一文件中的模型及校验射线。桥接同时核验运行 ID、attempt、输入哈希、两幅 FITS 哈希和映射文件哈希。映射文件缺失或校验失败时，该次图像和参数仍可展示。

已有会话继续支持原来的报告和缓存。旧 attempt 缺少可核验的依赖时，对应图位保留“—”。新清单只在新预检或阶段计算完成后的导出步骤生成。

「原始结果」展示与当前 Stage 和 attempt 绑定的 Pipeline 诊断图。M0–M3 的「Mask 图层」可单独勾选圆形视场、污染源和透镜弧。采样阶段的「联合后验」从 `Stage*_JointPosterior.json` 读取同一次联合样本和权重，选参时按需使用 GetDist 计算 68% 和 95% 概率轮廓。前端只接收该参数对的轮廓坐标。桥接所用 Python 环境通过 `requirements-display.txt` 安装 GetDist 和 ContourPy。旧运行可展示具备对应可核验证据的产物。

数据预览的原始结果是 `preflight_6panel.png` 和 `preflight_2panel.png`。新版清单通过 `raw_artifacts` 核验文件哈希。缺少该索引的旧清单可从同一运行已核验的 `inspection.json` 读取其中声明的固定路径。没有展示清单的旧运行也可用明确报告的 `inspection.json` 或单张预检图作为入口，桥接核对冻结输入、运行版本和 PNG 格式。已登记哈希的图片校验失败时留空。

Pipeline AI 在建模完成后登记 `modeling-comment.json`。新版文件按 `preflight`、`a`、`b`、`m0`、`m1`、`m2`、`m3` 保存每个阶段 1–2 句的总结和评价。「建模点评」在 M3 后按流程顺序逐行展示，旧运行仍可查看原先登记的简评。右侧的「最终参数」沿已接受的 M3 依赖关系查找每项参数最后一次优化的结果。采样参数显示加权后验中位数和 q16、q84 对应的非对称误差，证据扫描最优值和固定参数显示已保存的数值。

历史 Stage A 的展示清单未登记映射文件时，工作台可以用该 attempt 已核验的质量参数 q50 和图像坐标标定重建曲线和双向平面联动。已有映射文件仍按清单核验。

#### 阶段状态与结果版本

新预检生成的 `run_id` 固定在 `run-manifest.json`，整体重跑生成新 ID。`tinylens.stage-report.v1` 报告将状态绑定到 `run_id`、`run_path`、`lens_id`、`stage` 和 `attempt`。`running` 表示运行中，`executed` 表示执行完成，`awaiting_review` 和 `reviewing` 表示等待或进行科学审查，`accepted` 对应 AI 明确报告且桥接核验到同一 attempt 的正式接受记录。报告可附同一 attempt 的 `display_manifest`。

结果页默认显示最近的可用已接受版本，阶段导航显示当前的运行或审查状态。侧栏「历史记录」可查看旧 attempt。重复使用同一输出路径重跑时，AI 明确报告旧运行归档后的 `run-manifest.json`，桥接据此定位既有展示文件，并核对旧 `run_id`。旧版报告在能核对同一运行与 attempt 时继续参与版本选择。

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
| 没有输入图像 | 核对输入封装及校验值。让 AI 显式报告 `input-provenance.json` 或同次预检记录；工作台从绑定的 FITS 数组绘图 |
| 某阶段图位为空 | 核对同一会话是否报告了对应的展示清单，以及 FITS、阶段摘要和冻结依赖是否通过校验；旧运行可核对原 summary/PKL 报告 |
| 模型或服务层级不可用 | 核对 Codex 登录可用的模型和服务层级，以及桥接和专家的模型设置 |
| API 在交互 shell 可用，Web 不可用 | 检查 SSH 启动环境、私有 key 文件及包装器；不要把 key 放入 `VITE_*` |
| `No idle unlocked GPU is available` | runner 正按现有门槛等待；不会自动放宽资源门槛或把查询错误当作空闲 |
| 重新打开页面后未继续运行 | 恢复连接与恢复科学执行是不同操作；查看已有报告后向 AI 明确提出恢复要求，避免重复运行 |

不要上传 `.env.local`、Codex 登录、SSH 私钥、代理凭据、`.local/`、`pipeline/dataset/` 或 `pipeline/output/`。本仓库使用新的 Git 历史，只纳入可分发的源码、模板、测试和合成演示素材。

TinyLensGpu 及其版权/许可属于原作者，STCI 派生显示代码的许可随源码保留，见 [第三方说明](THIRD_PARTY_NOTICES.md)。
