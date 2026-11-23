# 模型与搜索设置

启动 npm run serve，在右侧设置填写 OpenAI 兼容 Base URL、模型名称和 API Key。密钥留空可沿用同一地址的已有密钥；更换地址必须提供新密钥。GET 不回传密钥原文。

教学推理用于导师的策略选择和课堂对话；内容核验推理用于独立解题、内容核对和主观题评阅。连接测试推理只用于最小连通请求。轻量档适合日常教学，深入档可能需要更长等待。

最大输出是渠道上限，具体任务通常限制为 16384 token。上下文预算计算包括工具定义、历史工具调用及推理内容，过大的输入不会被当作完整结果接受。

搜索可选择 Exa、Tavily Hikari 或自定义 HTTP MCP。返回链接会按公开地址安全规则再次读取，保存实际正文快照。可访问地址或多个域名本身不是事实正确证明。

网页保存的配置优先于环境变量，环境变量优先于 .env。地址、模型和限流设置会在后续传输尝试解析；新的教学推理设置在下一教学回合使用。

可选环境变量：

| 变量 | 用途 |
|---|---|
| TUTOR_AGENT_MODEL | 教学决策模型，默认使用全局模型 |
| TUTOR_REVIEW_MODEL | 内容核验模型 |
| TUTOR_SOLVER_MODEL | 盲解模型 |
| TUTOR_GRADER_MODEL | 主观题评分模型 |
| TUTOR_RESEARCH_MODEL | 教研模型 |
| TUTOR_REPAIR_MODEL | 内容修复模型 |
| TUTOR_AGENT_MAX_REQUESTS | 整回合请求上限，默认 16 |
| TUTOR_AGENT_MAX_STEPS | 整回合业务动作上限，默认 6 |
| TUTOR_SESSION_COST_LIMIT | 整回合估算预算，默认 2（按成本配置货币） |
| TUTOR_DAILY_COST_LIMIT | 每日估算预算，默认 10 |
| TUTOR_DAILY_REQUEST_LIMIT | 每日所有尝试次数，默认 100 |
| TUTOR_TURN_DEADLINE_MS | 整次处理总时限，默认 420000 |
| TUTOR_COURSES_ROOT / TUTOR_DATA_ROOT | 独立学习状态和运行目录 |
| TUTOR_TIMEZONE | 学习日历时区 |

不同角色的模型需要在同一配置渠道中可用。预算和用量覆盖独立调用与重试；失败尝试无用量时保留 unknown，估算不能冒充实际账单。代码实践的隔离执行不会继承这些服务密钥。
