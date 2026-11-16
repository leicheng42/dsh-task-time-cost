# Privacy and data / 隐私与数据

The plugin keeps task/route, timing, counters, reported usage, price resolution and estimation metadata in its own local storage domain. Prompt text may be transiently classified or counted on Host; prompts, code bodies, tool arguments and credentials are not stored in plugin statistics. Client does not read conversation bodies.

默认不上传统计、不额外调用估价模型、不自动联网更新。**模型预估默认开启**，但默认复用当前会话已在用的 provider/模型路由，因此不新增任何接收方；任务描述只用于该次请求、本地不保存。可在设置里一键关闭，或指定其它 provider/模型覆盖。执行 AI 可以用本次任务中的工具提交有界数字计划。公共价目录随包提供；维护脚本的手动联网更新与插件正常运行分开。

Configuration can contain provider/model identities, stable route fingerprints and custom rates. Do not put secrets in identity/source fields. A full export includes configuration, session/turn identities, history and calibration; it is **not anonymous**. Review and redact before sharing. Raw exports and conversation captures are excluded from the runtime package.

历史初始预估和原始价格版本保留。校准重置推进学习边界，保留调用/任务历史、用量、价格、配置、导入基线与原 DSH 会话，不承担匿名化或删除全部数据的含义。

Uninstall and explicit Host data-cleanup options are distinct operations. The current report states which retention path was actually tested. Preserve backups before data management; a version label alone does not establish retention or migration success.

Only reviewed, cropped captures of the actual feature may be shared. Do not share other sessions, message bodies, private endpoints or credentials. Diagnostics for publication use safe aggregate metadata and counts rather than raw histories.
