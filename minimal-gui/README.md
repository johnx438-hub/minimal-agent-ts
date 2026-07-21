# minimal-gui · 实验性浏览器 UI（WIP）

> **默认不推荐试用。** 展示冲刺遗留 dogfood 界面；问题与未完成项较多。  
> **不随** npm 包 `minimal-agent-ts` 发布。日常请用仓库根 **TUI**：`npm run tui`。

## 依赖

1. 先起 harness Web API（仓库根）：
   ```bash
   npm run web -- --allow-shell --web-port 7788
   ```
2. 再起本目录：
   ```bash
   npm install
   npm run dev
   ```
3. 环境变量见 `.env.local` 示例（`NEXT_PUBLIC_MINIMAL_BASE_URL` / token）。

## 状态

- 与 `src/web` API 对接（session / workspace / path_escape 等）。
- **非稳定**；打磨完成前不会写入 README「推荐路径」。
- 旧静态壳见 `public/web-ui-legacy/`（已归档）。
