# dsh-snapshot

为 DeepSeek Harness（`dsh`）Profile 提供本地、可回滚的配置快照。

> **发布状态：** 当前仓库只处于评审准备阶段。包被明确设置为私有，尚未发布到
> npm，也没有公开 GitHub Release。下面的安装流程使用本地 tarball；只有在你已经
> 获得授权的包规格时，才使用其他规格。

## 兼容性

实现针对 DSH rc.6 的公开接口：

- `@deepseek-ai/dsh` `0.1.0-rc.6`
- `@deepseek-ai/dsh-tools` `0.1.0-rc.6`
- `@deepseek-ai/dsh-llm` `0.1.0-rc.6`
- `@deepseek-ai/cordis` `4.0.1`
- Node.js `^22.19.0 || >=24.0.0`，支持 macOS、Linux、Windows

已针对 rc.6 检查公开的 `defineTool` 导出。真实 Profile 的打包 Loader smoke
仍是发布门禁，必须在可联网环境中通过；证据和当前未完成的验证见
[`docs/compatibility.md`](docs/compatibility.md)。

## 安装、重启和卸载

当前包尚未发布到 npm。在本仓库中先生成本地包，再把绝对路径的 tarball 添加到
已有 Profile，或让 DSH 初始化一个新的非默认 Profile：

```sh
npm ci
npm pack
dsh plugin --profile work add /absolute/path/to/dsh-snapshot-0.1.0.tgz
```

rc.6 中，`dsh plugin --profile <profile> add <npm-or-git-spec>` 是安装 npm、Git
或 tarball 规格的命令。`dsh plugin` 会把其余参数原样转发给 Profile 目录中的
pnpm；首次使用非默认 Profile 时也会初始化该 Profile。

安装或卸载 Bundle 后重启 Profile：

```sh
dsh --profile work
```

如果只想运行一次 headless 任务，rc.6 也支持：

```sh
dsh --profile work "run the requested task"
```

使用准确的包名卸载，然后重启 Profile：

```sh
dsh plugin --profile work remove dsh-snapshot
dsh --profile work
```

## 工具示例

插件只注册三个可由模型调用的工具。以下是工具调用，不是 shell 命令：

```text
snapshot_create({"profile":"work","label":"before upgrade"})
```

```text
snapshot_list({"profile":"work"})
```

```text
snapshot_restore({"snapshotId":"20260820T104530123Z-a1b2c3"})
```

第一个工具的 `label` 可省略；上面的 snapshot ID 仅为示例，应使用 create 或
list 返回的真实 ID。create 会把白名单中不存在的文件记录为 `absent`。restore
会先创建保护快照，并在结果中返回保护快照 ID。

## 收录哪些文件

插件只读取下面六个逻辑路径，目标路径全部由固定白名单生成：

| 逻辑路径 | `$DSH_HOME` 下的文件 |
| --- | --- |
| `home/settings.yaml` | `settings.yaml` |
| `home/cordis.patch.yml` | `cordis.patch.yml` |
| `profile/package.json` | `profiles/<profile>/package.json` |
| `profile/cordis.patch.yml` | `profiles/<profile>/cordis.patch.yml` |
| `profile/pnpm-lock.yaml` | `profiles/<profile>/pnpm-lock.yaml` |
| `profile/pnpm-workspace.yaml` | `profiles/<profile>/pnpm-workspace.yaml` |

恢复时，不存在状态仍保持不存在。每个存在的文件都会保存字节数、SHA-256 摘要
和可移植的 Unix mode 元数据；单文件上限为 10 MiB，单个快照总上限为 30 MiB。

插件不会读取 `.credentials.yaml`、`.env` 文件、会话、缓存、日志、
`node_modules` 或任意自定义文件，也不提供云同步、加密、保留策略、导入导出或
跨设备迁移。

## 存储位置与安全行为

快照只保存在本机：

```text
$DSH_HOME/snapshots/dsh-snapshot/v1/<snapshotId>/
```

每个完成的快照包含 `manifest.json` 和 `files/` 目录。写入时使用同级的
`.tmp-*` 临时目录，最后通过原子重命名发布。写锁位于：

```text
$DSH_HOME/snapshots/dsh-snapshot/v1/.writer-lock/
```

`DSH_HOME` 遵循 DSH 的优先级：宿主显式指定的 home、非空白 `DSH_HOME`，最后是
`~/.dsh`。快照内容可能包含敏感配置值；支持的平台会尽量收紧目录权限，但快照
**不加密**，也没有云端保护。不要把快照提交到 Git 或公开分享。

只应在 Profile 空闲时运行 `snapshot_restore`。恢复会涉及多个配置目录，因此它
具备可回滚保证，但不是观察者永远看不到中间态的全局原子提交。DSH 可能会热重载
patch 文件；每次恢复后都要重启 Profile。如果 `package.json` 或 `pnpm-lock.yaml`
发生变化，请手动运行下面的命令，然后重启：

```sh
dsh plugin --profile <profile> install --frozen-lockfile
dsh --profile <profile>
```

插件不会自动运行包管理器，也不会自动同步 `node_modules`。如果进程在多文件提交
过程中崩溃，可能需要依据生成的保护快照手动恢复；应检查结果，不能把中断视为已
成功完成。

### 手动恢复写锁

写锁采用 fail-closed 策略，不会根据年龄自动回收。如果操作返回 `BUSY`，先确认
持有锁的进程已经停止，再检查：

```text
$DSH_HOME/snapshots/dsh-snapshot/v1/.writer-lock/owner.json
```

只有完成上述确认后，才手动删除这个准确的锁目录。macOS/Linux：

```sh
rm -r "$DSH_HOME/snapshots/dsh-snapshot/v1/.writer-lock"
```

Windows PowerShell：

```powershell
Remove-Item -LiteralPath "$env:DSH_HOME/snapshots/dsh-snapshot/v1/.writer-lock" -Recurse -Force
```

绝不能删除仍被活动 writer 持有的锁。Windows 依赖当前用户的目录 ACL；ACL 是访问
控制，不是加密。

## 开发与验证

在仓库根目录运行：

```sh
npm ci
npm test
npm run typecheck
npm run lint
npm run format:check
npm run build
npm run smoke:loader
npm pack --dry-run
```

Loader smoke 使用真实 rc.6 CLI，把打包 tarball 安装到隔离 Profile，并确认已安装
Bundle 的 `apply` 真正执行。它需要公开的 DSH 依赖，以及 PATH 中可用的 pnpm。

本项目没有声称 npm 包或 GitHub Release 已存在。任何发布都必须经过明确授权，并
通过一次全新的完整发布门禁。
