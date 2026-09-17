# tutor（导师）

一个个性化教学 agent：从需求澄清、教研、摸底、规划，到讲授、检验、复习，全程因材施教。

- **设计文档**：[docs/design.md](docs/design.md)
- **技术基座**：[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（一切皆插件 + 会话日志唯一事实来源）
- **融合优点**：Reasonix 的缓存优先循环、工具调用修复、成本控制（实现为自定义循环插件）
- **模型接入**：OpenAI 兼容接口（base_url + api_key + model），不绑定单一供应商
- **交互形态**：命令行，单用户

## 状态

设计定稿，第一期实施中（单课程教学闭环）。

## 相关仓库

- [learn_agent](https://github.com/xiaoxixideyu/learn_agent) — agent 学习笔记、课程与概念沉淀
