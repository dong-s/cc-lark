# cc-lark

飞书 / Lark 的 Claude Code Channel MCP Server。

基于官方 `@larksuiteoapi/node-sdk`，用官方长连接接收入站消息，用官方 Open API 发送、编辑、撤回消息和上传文件。项目定位是 **Claude Code 的 Lark Channel**，不是 OpenClaw 插件复刻。

## 功能

- `login`：保存并校验 `app_id` / `app_secret`
- `reply`：回复消息，支持引用回复和附带图片 / 文件
- `edit_message`：编辑已发送文本消息
- `delete_message`：撤回消息
- 支持 `plaintext` / `file` 两种 secret 存储方式
- 入站消息自动添加 `Typing` reaction，成功回复后自动移除
- 文本消息按 Feishu `post + md` 发送
- 图片消息会先下载到本地，再提示 Claude 用 `Read` 工具分析图片
- 音频消息当前转发为 `[音频]`
- 支持基础策略：`requireMention`、`dmPolicy`、`groupPolicy`
- 支持飞书侧伪命令：`/help`、`/status`、`/new`、`/clear`、`/compact`

## 快速开始

### 1. 安装

```bash
cd /path/to/Lark-channel
npm install
npm run build
```

### 2. 注册 MCP Server

```bash
claude mcp add -s user lark-channel node /path/to/Lark-channel/dist/server.js
```

### 3. 启动 Claude Code

```bash
claude --dangerously-load-development-channels server:lark-channel
```

### 4. 配置凭证

命令行：

```bash
node dist/cli.js config <appId> <appSecret>
```

或在 Claude Code 内直接调用 `login` 工具。

## CLI

```bash
node dist/cli.js --help
node dist/cli.js status
node dist/cli.js info
node dist/cli.js doctor
```

`doctor` 会检查：
- 是否存在本地配置
- `appSecret` 是否可解析
- 当前凭证是否有效

## MCP 工具

### `login`

参数：
- `app_id`
- `app_secret`
- `domain`: `feishu | lark`，默认 `feishu`
- `secret_mode`: `plaintext | file`，默认 `plaintext`
- `require_mention`: 群聊是否要求 `@`，默认 `true`
- `dm_policy`: `open | pairing | allowlist`，默认 `open`
- `group_policy`: `open | allowlist`，默认 `open`

说明：
- `pairing` 当前仍按 `open` 处理
- `allowFrom` / `groupAllowFrom` / `groups` 目前没有 CLI 或 MCP 配置入口

### `reply`

参数：
- `user_id`
- `content`
- `media`：可选，本地媒体绝对路径
- `reply_to_message_id`：可选，引用回复的目标消息 ID

说明：
- 回复入站消息时，建议始终传 `reply_to_message_id=channel.message_id`
- 这样服务端才能在回复成功后清理对应的 `Typing` reaction
- 如果同时传了 `media`，媒体会作为额外一条消息发送

### `edit_message`

参数：
- `message_id`
- `content`

### `delete_message`

参数：
- `message_id`

## 入站消息处理

| 类型 | 当前行为 |
| --- | --- |
| `text` | 原样转发给 Claude |
| `image` | 下载到本地临时文件，并提示 Claude 先用 `Read` 读取图片 |
| `audio` | 转发为 `[音频]` |
| `file` | 转发为 `[文件]` |
| `video` | 转发为 `[视频]` |
| `media` | 转发为 `[media]` |
| `reaction` | 转发为简化占位信息 |

## 飞书侧伪命令

- `/help`：查看说明
- `/status`：查看当前 channel 状态
- `/new`：让下一条消息按新话题转发给 Claude
- `/clear`：等价于 `/new`，不是 Claude Code 原生 `/clear`
- `/compact`：让 Claude 输出当前会话摘要

## 本地状态文件

```text
~/.claude/channels/lark/channel.json
~/.claude/channels/lark/lark.secrets.json
```

`file` secret mode 下会校验：
- 文件存在
- 不是软链接
- 是普通文件
- 文件权限足够收敛（非 Windows）

## 运行建议

同一时间只保留一个加载了 `server:lark-channel` 的 Claude Code 会话。

如果同时运行多个 Claude / `lark-channel` 进程，飞书事件可能被其他会话拿走，表现为消息收发不稳定。

## 当前限制

- `pairing` 还没有独立配对流程
- `allowFrom` / `groupAllowFrom` / `groups` 还没有可配置入口
- `reaction` / `file` / `video` / `media` 的上下文仍比较简化
- 音频消息当前只转发为 `[音频]`，不做内容识别
- 目前只支持 `post + md` 文本样式，不支持卡片、流式状态、确认按钮等更完整交互
- `reply.media` 不会和文本合并成同一条消息
