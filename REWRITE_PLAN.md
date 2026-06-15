# Freelens Rust 重写计划

## 1. 项目目标

使用 Rust 重写 Freelens 的 Windows 原生桌面能力和本地后端服务，同时保留现有产品行为，并允许应用以渐进方式完成迁移。本项目只支持 Windows，不规划 macOS 和 Linux 版本。

建议的第一阶段目标是：

> Tauri 2 桌面外壳 + Rust 后端服务 + 现有 React/TypeScript 渲染层。

不建议立即将整个应用改写为 Rust 原生 UI。当前应用大量依赖 React、MobX、Monaco Editor、xterm、虚拟化资源列表，以及基于 JavaScript 的 Lens 扩展生态。一次性重写会带来很高的成本和兼容风险。

这里的“Rust 后端服务”不是部署在服务器上的远程后端，而是和桌面程序一起安装、运行在用户 Windows 电脑上的本地应用核心。它运行在 Tauri 主进程中，接管原 Electron 主进程的大部分职责。

三层职责如下：

- Tauri 桌面外壳：创建和管理 Windows 窗口、WebView2、系统托盘、菜单、深度链接、单实例运行和应用生命周期。
- Rust 后端服务：访问 Kubernetes、读取 kubeconfig、管理凭据、运行 kubectl/Helm/PowerShell、创建终端和端口转发、读写文件、维护长连接与后台任务。
- React/TypeScript 渲染层：负责页面、表格、图表、编辑器、终端显示、用户输入和状态展示，不直接获得任意文件系统或进程执行权限。

React 通过 Tauri command 调用 Rust，通过 Tauri event 或 channel 接收 Kubernetes watch、日志和终端输出。这样既能保留现有 UI，又能把需要系统权限、并发控制和资源清理的部分放到 Rust 中。

## 2. 当前架构

Freelens 当前是一个 Electron monorepo，主要包含两个进程：

- Electron 主进程：负责窗口生命周期、文件系统访问、子进程、Kubernetes 代理、kubectl、Helm、终端会话、扩展、系统托盘和操作系统集成。
- Renderer 渲染进程：负责 React 17 UI、MobX 状态、路由、Kubernetes 资源视图、Monaco Editor、xterm、偏好设置和扩展提供的界面组件。

当前架构的主要机制包括：

- 使用 `@ogre-tools/injectable` 实现依赖注入。
- 使用显式生成的 DI 注册文件。
- 使用 Electron IPC 和内部消息包进行进程间通信。
- 在主进程和渲染进程中加载兼容 Lens 的 JavaScript/React 扩展。
- 内置 kubectl、Helm 和 Kubernetes 身份认证代理二进制文件。

当前代码库约有 3,800 个 TypeScript 和 TSX 文件。因此，一次性重写风险过高，也很难验证新旧实现是否一致。

## 3. 推荐技术栈

### 桌面外壳

- Tauri 2
- 使用 Windows WebView2 承载现有 React UI
- 使用 Tauri commands 处理请求和响应
- 使用 Tauri events 或 channels 传输流式数据
- 只构建和发布 Windows x64 版本；是否支持 Windows ARM64 在首个稳定版本后再评估

### Rust 后端

- `tokio`：异步运行时
- `serde` 和 `serde_json`：IPC 数据契约和序列化
- `thiserror` 和 `anyhow`：错误处理
- `tracing` 和 `tracing-subscriber`：结构化日志
- `kube` 和 `k8s-openapi`：Kubernetes API
- `reqwest`：HTTP 请求
- `notify`：监视配置文件和扩展目录变化
- `portable-pty` 或 Windows ConPTY：终端会话
- Windows Credential Manager：存储适合由系统保护的凭据

### Rust 后端服务的具体作用

Rust 后端服务是 UI 与 Windows/Kubernetes 能力之间的安全边界，主要负责：

1. Kubernetes 通信：加载认证信息，访问 Kubernetes API，执行资源 list/watch/create/update/delete，以及 Pod logs、exec 和 port-forward。
2. 本地配置：发现、解析、合并、校验和监视 kubeconfig，管理应用设置和集群目录。
3. 外部进程：启动和管理 kubectl、Helm、PowerShell 及认证插件，处理标准输入输出、超时、取消和退出状态。
4. 流式任务：持续读取 Kubernetes watch、Pod 日志、指标和终端输出，并以有界通道发送给 React。
5. Windows 集成：负责窗口、托盘、通知、协议注册、文件选择、应用路径、凭据和安装更新相关能力。
6. 安全控制：只向 React 暴露明确允许的命令，校验参数和路径，避免渲染层直接执行任意命令或读取任意文件。
7. 生命周期管理：在关闭集群、窗口或应用时，取消后台任务，终止子进程，关闭网络连接并释放端口。

例如，用户在 React 页面点击“查看 Pod 日志”时，React 只提交集群、命名空间和 Pod 标识。Rust 负责认证、建立 Kubernetes 日志连接、处理重连和取消，并把日志流发送回页面。

### 迁移期间保留的现有前端技术

- React 和 TypeScript
- 现有组件包和样式
- Monaco Editor
- xterm
- 现有资源视图和导航结构

## 4. 推荐的仓库结构

```text
freelens-rust/
|-- Cargo.toml
|-- crates/
|   |-- freelens-app/            # Tauri 应用和启动逻辑
|   |-- freelens-domain/         # 共享领域模型
|   |-- freelens-ipc/            # 带版本控制的前后端通信契约
|   |-- freelens-kube/           # Kubernetes 客户端、watch、exec 和日志
|   |-- freelens-kubeconfig/     # Kubeconfig 发现和管理
|   |-- freelens-helm/           # Helm 操作
|   |-- freelens-terminal/       # PTY 和 Shell 会话
|   |-- freelens-catalog/        # 集群目录和同步
|   |-- freelens-settings/       # 应用设置持久化
|   |-- freelens-platform/       # Windows 窗口、托盘、协议和系统服务
|   `-- freelens-extension-host/ # 旧扩展兼容层
|-- frontend/                    # 迁移期间使用的 React 渲染层
|-- tests/
|   |-- contract/                # IPC 兼容性测试
|   `-- parity/                  # Electron 与 Rust 行为对比测试
`-- docs/
```

Crate 的边界应按照行为和职责划分，不应机械复制现有 TypeScript 的每个 feature 目录。

## 5. 迁移阶段

### 阶段 0：建立基线和通信契约

- 记录应用启动、集群加载、资源列表、watch、日志、终端、Helm 和扩展的现有工作流程。
- 盘点现有 Electron IPC 和消息通道。
- 定义带版本控制的 Rust/TypeScript IPC 数据结构。
- 根据当前真实行为建立契约测试数据。
- 建立启动时间、内存占用和资源 watch 负载的性能基线。

交付物：文档化的兼容性契约和可重复执行的基线测试。

### 阶段 1：Tauri 桌面外壳

- 创建 Cargo workspace 和 Tauri 2 应用。
- 尽量少改动地加载现有 React 渲染层。
- 实现应用启动、单实例运行、窗口状态、应用路径、日志和优雅退出。
- 在 TypeScript 中引入传输层抽象，使其可以使用 Electron IPC 或 Tauri commands。

交付物：现有 UI 可以在 Tauri 中运行，并调用一个简单的 Rust 健康检查或系统 API。

### 阶段 2：Kubeconfig 和集群目录

- 使用 Rust 实现 kubeconfig 的发现、解析、校验、合并和变化监视。
- 实现集群目录的持久化和同步。
- 在可行范围内保留现有 context 标识符和面向用户的错误行为。
- 为格式错误、合并配置、exec 身份认证、证书和多 context 配置添加测试数据。

交付物：通过 Rust 服务发现和打开集群。

### 阶段 3：Kubernetes 数据层

- 使用 `kube` 实现 API discovery 和动态资源支持。
- 实现带取消、重试、退避和 resource version 恢复能力的 list/watch 数据流。
- 实现资源创建、patch、replace 和 delete 操作。
- 实现 Pod 日志、exec、attach 和端口转发。
- 将 watch 和日志事件传输到渲染层，同时避免无限制缓冲。

交付物：主要集群资源页面不再依赖 Electron 主进程。

### 阶段 4：外部工具和终端

- 实现 kubectl 版本选择和命令执行。
- 使用 `portable-pty` 实现本地 Shell 和集群终端会话。
- Pod Terminal 后续支持选择常见 Shell，并允许输入自定义 Shell 绝对路径；自动探测默认按 `bash`、`sh`、`ash`、`zsh` 顺序执行，以覆盖 `fish`、`dash`、`ksh` 或非标准安装路径等情况。
- 增加进程取消、退出状态、输出限制和应用关闭时的清理机制。

交付物：kubectl 和终端工作流通过 Rust 运行。

### 阶段 5：平台服务

- 迁移协议处理器、深度链接、系统托盘、菜单、通知和更新功能。
- 迁移设置和安全凭据。
- 使用 Windows Credential Manager 处理适合由系统保护的凭据。
- 实现 Windows 注册表协议注册、WebView2 运行时检测和 Windows 通知。

交付物：Tauri 可以在正常应用运行过程中完全替代 Electron。

### 阶段 6：扩展系统

- 在兼容期保留 JavaScript 扩展宿主。
- 定义从扩展到 Rust 服务的、基于能力授权的桥接层。
- 将可信应用 API 与扩展 API 分开。
- 决定继续保持完整 Lens 兼容，还是推出新的 Freelens 扩展 SDK。
- WebAssembly 仅作为未来非 UI 扩展的候选方案；它无法直接替代 React 扩展组件。

交付物：形成有明确兼容等级、文档完整且具备隔离能力的扩展方案。

### 阶段 7：移除 Electron

- 针对受支持的工作流程运行 Electron 和 Tauri 行为一致性测试。
- 完成 Windows x64 的安装包、代码签名、卸载和应用更新测试。
- 根据发布方式选择 MSI 或 NSIS，并测试覆盖安装、降级阻止和配置保留行为。
- 只有在兼容性和发布标准全部满足后，才移除 Electron 专用代码。

交付物：生产环境使用 Tauri/Rust 构建替代 Electron 构建。

## 6. IPC 设计原则

- IPC 结构必须显式定义类型并进行版本控制。
- Commands 应使用可序列化的请求和响应类型。
- 长时间运行的操作应返回 operation ID 或 session ID。
- Watch、日志、终端和进度数据应使用有容量限制的流式通道。
- 每个数据流都必须支持取消和资源清理。
- Rust 错误应包含稳定、机器可读的错误码，并将其与面向用户的错误信息分开。
- 前端代码不应直接依赖 Tauri API，而应使用应用自身定义的传输接口。

建议的服务分组：

```text
system.*
settings.*
kubeconfig.*
catalog.*
kubernetes.*
helm.*
terminal.*
platform.*
extensions.*
```

## 7. 兼容迁移策略

迁移期间，前端传输层应支持两种后端：

```text
应用 UI
   |
传输接口
   |-- Electron transport -> 现有 TypeScript 实现
   `-- Tauri transport    -> Rust 实现
```

通过这种方式，可以逐个将服务迁移到 Rust，而不需要一次性替换整个应用。两种实现可以使用相同的 JSON 测试数据和行为测试用例。

## 8. 主要风险

### 旧版扩展兼容性

Lens 扩展可以执行 JavaScript，并提供 React UI、导航、菜单和 Kubernetes 行为。纯 Rust 应用无法在不保留 JavaScript/WebView 宿主的情况下兼容这些 API。

### Kubernetes 身份认证

Kubeconfig 可能使用 exec 插件、云服务商认证、客户端证书、代理和自定义环境变量。要保持认证兼容，需要大量测试数据和集成测试。

### 流式数据和背压

Kubernetes watch、日志、指标和终端会持续产生数据。IPC 缓冲机制如果设计不当，可能导致内存占用过高或 UI 卡死。

### Windows 平台差异

虽然不需要处理 macOS 和 Linux，但仍需覆盖受支持 Windows 版本之间的差异，包括 WebView2 Runtime、ConPTY、PowerShell 版本、路径长度、证书库、代理设置、UAC、代码签名和企业设备策略。

### 行为偏差

如果没有契约测试，重新实现 API 时可能会在错误处理、重试、resource version、排序或扩展行为上产生不易察觉的差异。

## 9. 第一个里程碑

首个实现里程碑应只包含以下内容：

1. Cargo workspace。
2. Tauri 2 桌面应用。
3. 在 Tauri WebView 中加载现有 React 渲染层。
4. 创建共享的 `freelens-ipc` crate，并实现带版本控制的健康检查请求和响应。
5. 创建支持 Electron 和 Tauri 的 TypeScript 传输层抽象。
6. 实现 Rust 结构化日志和应用路径发现。
7. 为 IPC 序列化和应用启动服务添加单元测试。

这个里程碑用于在引入 Kubernetes 和扩展系统的复杂性之前，验证整体迁移架构是否可行。

## 10. 成功标准

- 现有用户工作流程由行为一致性测试覆盖。
- Kubernetes watch 在重新连接和集群异常后仍能稳定恢复。
- 关闭集群或应用时，所有子进程和数据流都能被取消并清理。
- 渲染层不能直接访问不受限制的文件系统或进程 API。
- 与 Electron 基线相比，启动时间和空闲内存占用有可测量的改善。
- Windows x64 安装包通过安装、覆盖安装、卸载、代码签名和更新测试。
- 明确记录扩展兼容程度，而不是默认假设完全兼容。

## 11. 接下来的工作

### 高优先级：核心 Kubernetes 体验

- [x] 接入 Metrics API，并展示 Pod 和 Node 的 CPU、内存指标；Metrics Server 不可用时正常降级。
- [ ] 增加集群概览 Dashboard，汇总工作负载、资源用量和异常状态。
- [ ] 增加 Kubernetes Events 独立视图和筛选。
- [ ] 继续完善资源详情页和常用操作，包括扩缩容、重启及触发 Job。
- [ ] 补充 Pod attach 能力。
- [ ] 验证 watch 断线重连、退避和 resource version 恢复。
- [ ] 为大规模资源列表增加虚拟滚动并完成性能验证。

## 12. 低优先级兼容功能

### IPC 与权限安全加固

在主要 Kubernetes 工作流和平台基础能力稳定后，再集中审查 Tauri IPC 暴露面、命令参数校验、ACL/capabilities 以及文件系统访问范围，并补充非法参数和越权访问测试。

### Helm 工作流

Freelens 提供 Helm 仓库、Chart、Release 安装、升级、回滚和卸载功能，但该工作流并非当前原型的高频核心需求。在 Kubernetes 资源浏览、编辑、日志、终端、端口转发、kubectl 和平台能力稳定后，再补充 Helm 兼容实现。

建议的最小实现顺序：

1. 发现 Helm 可执行文件及版本。
2. 列出当前集群中的 Releases。
3. 查看 Release 状态和 values。
4. 支持安装、升级、回滚和卸载。
5. 支持进程取消、输出限制和结构化错误展示。

### 代理与证书设置

代理和自定义 CA 证书属于企业网络兼容能力，使用频率和当前原型优先级低于 Helm。在主要 Kubernetes 工作流、平台服务和 Helm 兼容功能稳定后，再实现代理与证书设置。

建议的最小实现顺序：

1. 支持 HTTP、HTTPS 代理及 `NO_PROXY`。
2. 支持导入自定义 CA 证书。
3. 将代理和证书设置应用到 Kubernetes 客户端及 kubectl。
4. 提供连接测试和明确的错误提示。
5. 使用 Windows Credential Manager 保存代理凭据等敏感信息。
