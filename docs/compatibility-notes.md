# OpenAI-compatible 兼容性记录

本文件仅记录真实模型闭环验收中实际观察到的协议差异，以及对应的最小兼容性修复。不会记录 API key、完整对话内容或工具输出。

## 2026-08-29

- 已使用 OpenAI-compatible 配置的 `glm-5.3` 在隔离 scratch 仓库完成一次真实验收：读取 `calculator.js` 和测试文件，第一次 patch 后 `run_tests` 失败，第二次 patch 后 `run_tests` 通过。
- 本次响应可由现有 Chat Completions adapter 正常解析，未观察到需要修复的 provider 兼容性差异。
- 已有回归覆盖：assistant `content: null` 归一化为空字符串；缺失 `finish_reason` 归一化为未指定结束原因；非法工具 `arguments` 拒绝并且不回显原始参数。
