# 模型与搜索设置

启动 npm run serve，在右侧设置填写 OpenAI 兼容 Base URL、模型名称和 API Key。密钥留空可沿用同一地址的已有密钥；更换地址必须提供新密钥。GET 不回传密钥原文。

教学推理用于导师的策略选择和课堂对话；内容核验推理用于独立解题、内容核对和主观题评阅。连接测试推理只用于最小连通请求。轻量档适合日常教学，深入档可能需要更长等待。

“判断模型（可选）”提供两种方式：

- **大模型判断（默认）**：完全使用原有核验路径，不调用快速判断服务。“核验大模型”可填写同一渠道的其他模型名；留空沿用主模型。
- **TypeSafe / Jev 辅助判断**：使用独立的服务地址、模型名与 API Key。默认地址 https://api.typesafe.ai/v1，默认模型 jev-latest。画像背景和每条偏好按学员原话核对；候选内容进行范围预检。明显不符的候选可以提前拒绝，其他教材内容继续接受完整的大模型正确性审核、盲解及数值检查。

选择 TypeSafe 时，问题按类型化接口批量提交。置信度和所选结论的概率均达到阈值时才采用，默认阈值 0.95；这是保守初值，需要使用自己的教学样例校准。服务不确定、响应不合法、超时或上下文过大时，回退所选核验大模型；预算用尽和用户暂停不会通过回退绕过限制。对候选教材，即使快速预检通过，大模型审核仍保留，因此不能保证整体速度或成本下降。

“测试快速判断连接”仅发送固定的非个人样例，不发送课程记录，不保存或启用表单配置；实际使用需要点击“保存设置”。测试与业务判断都计入每日请求和用量记录。TypeSafe 的输出 token 仍记录，但按当前官方规则不计输出费用；输入费用按 config/cost.yaml 估算，使用时应按实际渠道费率更新。

快速判断密钥不回显，不与主模型密钥共用。同一判断服务地址下留空可沿用；更换地址需要新密钥。关闭选项后保留连接以便再次启用，但不向该服务发送请求。网页保存的明确关闭状态优先于环境变量的启用状态。

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
| TUTOR_JUDGMENT_PROVIDER | llm（默认）或 typesafe；网页选择优先 |
| TUTOR_JUDGMENT_BASE_URL | 快速判断服务基础地址，默认 https://api.typesafe.ai/v1 |
| TUTOR_JUDGMENT_MODEL | 该服务的判断模型，默认 jev-latest |
| TUTOR_JUDGMENT_API_KEY | 独立的快速判断服务密钥 |
| TUTOR_JUDGMENT_MIN_CONFIDENCE | 所选结论概率与置信度阈值，默认 0.95 |
| TUTOR_JUDGMENT_TIMEOUT_MS | 含排队的等待上限，默认 5000 毫秒 |
| TUTOR_JUDGMENT_REQUESTS_PER_MINUTE | 该判断渠道的每分钟请求数，默认 60 |
| TUTOR_AGENT_MAX_REQUESTS | 整回合请求上限，默认 16 |
| TUTOR_AGENT_MAX_STEPS | 整回合业务动作上限，默认 6 |
| TUTOR_SESSION_COST_LIMIT | 整回合估算预算，默认 2（按成本配置货币） |
| TUTOR_DAILY_COST_LIMIT | 每日估算预算，默认 10 |
| TUTOR_DAILY_REQUEST_LIMIT | 每日所有尝试次数，默认 100 |
| TUTOR_TURN_DEADLINE_MS | 整次处理总时限，默认 420000 |
| TUTOR_COURSES_ROOT / TUTOR_DATA_ROOT | 独立学习状态和运行目录 |
| TUTOR_TIMEZONE | 学习日历时区 |

不同角色的模型需要在同一配置渠道中可用。预算和用量覆盖独立调用与重试；失败尝试无用量时保留 unknown，估算不能冒充实际账单。代码实践的隔离执行不会继承这些服务密钥。

协议依据：[TypeSafe System One API](https://docs.typesafe.ai/api/system-one)。本项目判断服务目前支持该协议；其他厂商若使用不同协议，需要增加相应适配器。
