# 更新日志

## [1.1.0] - 2026-11-26

### 新增

- 首次启动若没有任何配置文件，会自动生成空白的 `mistral_config.json`，克隆后可直接在 GUI 里填写卡号 / 地址并开始注册。
- 侧栏底部显示应用版本号；`GET /api/overview` 的 `env` 中同时返回 `version`。

### 修复

- 缺少 `test_pipe_config.json` / `accounts.json` 时不再反复打印原始 `ENOENT`，改为一次性中文提示并说明如何生成。
- 反代只接收真实存在的配置文件；没有配置文件但有账号时仍能自动启动并使用 `accounts.json` 账号池。
- 账号池为空时跳过自动启动反代，避免首次安装出现失败任务；提示完成注册后手动「重启反代」。
- `/health` 的 `config` 字段在配置文件缺失时返回 `null`，不再谎报文件名。
- 端口被占用时的提示改为推荐 `${PORT + 1}`，不再写死旧端口。

### 变更

- 默认端口调整为 GUI `8890`、反代 `8899`，与常见的本地服务端口错开。
- 仓库不再包含任何账号 / 卡号 / 会话示例数据；`package.json` 补充 `engines` / `os` / `repository` / `keywords`。

### 文档

- 重写 README：快速开始、首次运行要准备的文件、界面预览、常见问题、数据与安全。
- 新增 5 张 GUI 截图（批量注册 / 卡池管理 / 账号库 / 用量看板 / 运行日志），均为虚构演示数据。

## [1.0.0] - 2026-11-26

### 新增

- 首个公开发布版：批量注册、卡池管理、卡号 Luhn 校验、账号库、Pro 检测、额度体检、OpenAI 兼容对话反代（含 tools / function calling）、用量看板、临时邮箱 Token 池、Vibe 桌面端账号一键切换。

[1.1.0]: https://github.com/suimi8/mistral-toolbox/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/suimi8/mistral-toolbox/tree/v1.0.0
