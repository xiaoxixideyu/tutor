# tutor（导师）

一个个性化教学 agent：从需求澄清、教研、摸底、规划，到讲授、检验、复习，全程因材施教。

- **设计文档**：[docs/design.md](docs/design.md)
- **技术基座**：[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（一切皆插件 + 会话日志唯一事实来源）
- **融合优点**：Reasonix 的缓存优先循环、工具调用修复、成本控制（实现为自定义循环插件）
- **模型接入**：OpenAI 兼容接口（base_url + api_key + model），不绑定单一供应商
- **交互形态**：命令行，单用户

## 状态

设计定稿，第一期实施中（单课程教学闭环）。已完成：环境搭建、最小 agent 循环、课程状态插件（第一期任务 1-3）。

核心能力位于 `src/core/`（不依赖 Harness 与命令行，`npm test` 独立测试）；`src/plugin/course-state.ts` 以 dsh 插件形态暴露 `ctx.courseState` 服务（`config/cordis.patch.yml` 模板 + `scripts/agent.mjs` 渲染挂载）。

## 环境要求

- **Node ≥ 22.19，建议 24 LTS**（Harness 依赖 `import.meta.main`，仅官方实测 22.19/24/26；Node 23 会静默失效）
- Harness 锁定 `@deepseek-ai/dsh@0.1.5-rc.1`（开发预览期，升级需显式变更）

## 快速开始

```sh
npm install
cp .env.example .env   # 填入 base_url / api_key / model 三要素
npm run agent -- "你好" # 一次性 agent 任务（headless 档案）
```

- 模型接入模板：`config/settings.yaml`（由 `scripts/agent.mjs` 渲染为运行时副本）
- 会话日志：`data/dsh-home/sessions/`（JSONL 压缩存储，唯一事实来源，勿手改）

## 相关仓库

- [learn_agent](https://github.com/xiaoxixideyu/learn_agent) — agent 学习笔记、课程与概念沉淀
