# DSH Snapshot MVP 设计规格

日期：2026-08-20
目标版本：v0.1.0
许可：MIT

## 1. 背景与依据

`dsh-snapshot` 是一个开源、纯本地的 DeepSeek Harness（DSH）Cordis 插件，为一套指定 Profile 的关键配置创建可恢复快照。

本规格以官方仓库 `deepseek-ai/deepseek-harness` 的 `master` 提交 `141eb6fef83422698aef7a981029e843e8161534` 为依据。已确认：

- DSH Home 的解析优先级为显式配置、`DSH_HOME`、`~/.dsh`，空白 `DSH_HOME` 视为未设置（[`home-paths`](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/packages/util/home-paths/src/index.ts)）。
- Profile 位于 `$DSH_HOME/profiles/<name>`，官方会拒绝空名称、`.`、`..`、`node_modules` 及包含 `/` 或 `\` 的名称（[`profile.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/packages/boot/app-boot/src/profile.ts)）。
- 外部 Bundle 由 `package.json` 的 `dsh.bundle.patch` 声明，通过 `dsh plugin --profile <name> add <spec>` 安装（[`plugin.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/apps/cli/src/plugin.ts)）。
- 普通工具插件使用命名导出 `name`、`inject`、`apply`，在 `apply` 中调用 `ctx.tools.register(defineTool(...))`；不使用 default export（[`tool-todo`](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/packages/todo/tool-todo/src/index.ts)）。

## 2. 目标与非目标

目标：提供 `snapshot_create`、`snapshot_list`、`snapshot_restore` 三个模型可调用工具；支持指定 Profile；恢复前自动创建保护快照；以白名单、完整性校验和可回滚事务降低配置损坏风险；支持 macOS、Linux、Windows；提供 TypeScript 源码、自动化测试、中英文 README 和 GitHub Actions。

非目标：会话、`node_modules`、缓存、日志、凭据文件、`.env`、云同步、压缩包导入导出、定时任务、Web UI、快照加密、跨机器自动迁移、快照保留策略。尤其不备份 `$DSH_HOME/.credentials.yaml`，避免本工具主动复制密钥。

## 3. 用户流程与工具契约

### `snapshot_create`

输入：`profile`（必填）、`label`（可选，短文本）。插件校验 Profile 名称，扫描白名单文件，创建不可变快照。不存在的白名单文件也记录为 `absent`，从而保留完整状态。输出包括 `snapshotId`、时间、Profile、已收录与缺失文件、敏感数据警告。

### `snapshot_list`

输入：`profile`（可选过滤）。读取各快照的 manifest，并确认其声明的 payload 文件存在且类型安全，但不重新读取正文计算 SHA-256。按创建时间倒序输出 ID、标签、Profile、类型（普通/保护）、文件数、总字节和状态；manifest 无效或 payload 缺失的条目显示为 `corrupt`，其他条目显示为 `available`。完整摘要校验留到恢复预检，损坏条目不能导致整个列表失败。

### `snapshot_restore`

输入：`snapshotId`（必填）。不接受任意路径。流程为：解析固定快照目录中的 ID、校验 manifest 和全部文件摘要、校验目标仍在白名单、在同一写锁内创建当前状态的保护快照、预备所有替换文件、提交恢复。保护快照调用不重复获取写锁，避免自锁。输出恢复的文件、按快照删除的文件、保护快照 ID；若 Profile 的 `package.json` 或 `pnpm-lock.yaml` 发生变化，还应提示用户运行 `dsh plugin --profile <profile> install --frozen-lockfile`，随后重启对应 Profile。插件本身不调用包管理器。

三个工具返回稳定的结构化 JSON 值，并渲染简短文本。创建与恢复不是并发安全操作：进程内由互斥锁串行化，进程间在快照根目录使用原子创建的锁目录并 fail-closed；进程异常退出遗留锁时不自动猜测过期，错误信息应给出锁位置和人工核查、删除步骤。列表读取可并发，但必须忽略写入中的临时目录。

## 4. 包形态与模块边界

发布物是单一 npm 包 `dsh-snapshot`：清单声明 ESM、编译后的入口、类型、MIT、所需 peer dependencies，并以 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` 声明 Bundle。`cordis.patch.yml` 插入一个指向本包的插件行；入口使用命名导出并注入 `tools`。

逻辑划分如下：

- **plugin**：Cordis 生命周期、工具 schema、结果渲染；不包含文件事务细节。
- **paths/policy**：解析 DSH Home、校验 Profile/快照 ID、生成唯一白名单路径。
- **repository**：快照目录、manifest、摘要、列举与临时目录发布。
- **capture**：一致地读取白名单文件并生成普通或保护快照。
- **restore transaction**：预检、暂存、提交、失败回滚与清理。
- **errors**：稳定错误码与可操作提示，底层绝对路径不默认暴露给模型。

实现开始前必须验证 npm 上已发布 DSH 包的确切版本范围、`defineTool` 的公开导出稳定性，以及外部 Bundle 自引用插件行的 Loader smoke test；若当前发行版与上述提交不一致，以安装目标版本的实际公开接口为准并更新文档。

## 5. 数据布局与格式

快照根目录固定为 `$DSH_HOME/snapshots/dsh-snapshot/v1/`；每个完成快照位于 `<snapshotId>/`，写入期间使用同级 `.tmp-<random>/`，最后原子重命名发布。ID 格式为 UTC 时间戳加随机后缀，例如 `20260820T104530123Z-a1b2c3`，只接受固定正则，不接受路径分隔符。

目录包含 `manifest.json` 与 `files/`。manifest 至少包含：`schemaVersion: 1`、`snapshotId`、`createdAt`、`profile`、`kind`、可选 `label`、创建时 DSH 版本（可检测时）、插件版本，以及 `entries[]`。每个 entry 包含逻辑路径、状态 `present|absent`；存在时还含字节数、SHA-256、保存文件名和原始权限（仅记录可移植的 Unix mode 位）。manifest 最后写入临时目录，发布后内容不可修改。

## 6. 文件白名单

唯一允许的逻辑路径为：

- `home/settings.yaml` → `$DSH_HOME/settings.yaml`
- `home/cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml`
- `profile/package.json` → `$DSH_HOME/profiles/<profile>/package.json`
- `profile/cordis.patch.yml` → `$DSH_HOME/profiles/<profile>/cordis.patch.yml`
- `profile/pnpm-lock.yaml` → `$DSH_HOME/profiles/<profile>/pnpm-lock.yaml`
- `profile/pnpm-workspace.yaml` → `$DSH_HOME/profiles/<profile>/pnpm-workspace.yaml`

目标路径必须由枚举映射生成，不从 manifest 拼接。读取前对现有文件执行 `lstat`：仅接受普通文件，拒绝符号链接、目录、设备和其他类型，以防白名单内链接逃逸。单文件默认上限 10 MiB、单快照默认上限 30 MiB；超限则整次创建失败，不产生半快照。Profile 目录不存在时创建失败，不替用户初始化 Profile。

## 7. 快照与恢复事务

创建事务：获取写锁；建立权限收紧的临时目录；逐项读取并计算 SHA-256；读取期间若文件元数据发生变化则重试一次，仍变化则失败；写 manifest；将临时目录原子重命名为最终目录。失败时清理临时目录。

恢复事务：获取写锁；完整预检快照；创建保护快照并确认发布成功；在每个目标文件的同目录写入随机临时文件、校验内容并同步文件；把所有当前目标移入同目录事务备份名；再逐个将暂存文件重命名到目标，`absent` 项保持目标不存在；成功后清理事务备份。任何提交步骤失败，立即按事务备份回滚所有已触及目标；若回滚也失败，返回高优先级错误、保护快照 ID 和残留路径提示，绝不宣称恢复成功。

跨多个目录不存在真正的单一原子提交，因此本设计保证“可回滚”，而非观察者永远看不到中间态。官方会热重载两个 `cordis.patch.yml`；用户应在 DSH 空闲时恢复，并在完成后重启对应 Profile。v0.1.0 不尝试停止或重启 DSH。

## 8. 错误、安全与隐私

稳定错误码包括：`INVALID_PROFILE`、`SNAPSHOT_NOT_FOUND`、`SNAPSHOT_CORRUPT`、`UNSAFE_FILE_TYPE`、`SIZE_LIMIT`、`BUSY`、`PROTECTION_FAILED`、`RESTORE_FAILED_ROLLED_BACK`、`RESTORE_FAILED_MANUAL_RECOVERY`。错误应说明阶段与补救方式，但不输出配置正文。

快照可能复制 `settings.yaml` 及 patch 中的敏感值；README 和每次创建结果必须提示：目录只保存在本机、不要提交 Git 或公开分享。创建目录尽力使用仅当前用户可访问权限（POSIX 目录 `0700`、文件 `0600`）；Windows 依赖当前用户目录 ACL，并明确这不是加密。日志不得记录文件正文或摘要以外的秘密信息。

## 9. 跨平台要求

全部路径使用 Node path API，不硬编码 `/`；临时文件必须与目标同目录以获得同卷重命名语义；处理 Windows 文件占用、`EPERM`、`EACCES` 并保留可操作信息；不得依赖 shell 命令。原始 mode 仅在 POSIX 恢复，Windows 忽略。时间统一 ISO 8601 UTC，manifest 使用 UTF-8 与 LF。

## 10. 测试与验收

单元测试覆盖 DSH Home 优先级、空白环境变量、Profile/ID 路径穿越、白名单映射、符号链接拒绝、manifest schema、摘要、大小限制、缺失文件语义、损坏列表隔离和错误映射。

集成测试全部使用临时 DSH Home，覆盖：创建→修改→恢复后逐字节一致；快照为 `absent` 时删除后来出现的目标；恢复前保护快照可反向恢复；中途注入写入/重命名失败后原状态保持；损坏摘要在任何目标变化前被拒绝；并发创建/恢复被串行化；临时目录不出现在列表。CI 在 Ubuntu、macOS、Windows 的当前 Node LTS 上运行测试、类型检查、lint 和构建。

v0.1.0 验收条件：三个工具可由真实 DSH Profile 调用；六类白名单文件的存在/缺失状态准确恢复；恶意 Profile、快照 ID、符号链接或篡改快照无法写出白名单；失败恢复不会静默留下混合状态；仓库包含中英文 README、MIT License、可复现构建和全绿 CI。

## 11. 发布与已知限制

先发布 GitHub `v0.1.0` Release 和源码；npm 发布可在 Loader smoke test 通过后进行。README 给出 `dsh plugin --profile <name> add <npm-or-git-spec>` 安装、重启 Profile、三工具示例、卸载和敏感数据说明。不得在未实际创建远端 Release 时声称已发布。

已知限制：快照不加密、不跨设备；不包含凭据、会话或额外自定义文件；异常退出可能留下需要人工核查后删除的进程间锁目录；崩溃发生在多文件提交中间时可能需要依据保护快照人工恢复；恢复依赖元数据不会自动同步 `node_modules`，用户必须按工具提示重新安装依赖；与未来 DSH 插件 API 的兼容性取决于公开接口稳定性。
