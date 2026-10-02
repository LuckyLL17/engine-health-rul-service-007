# 航空发动机健康状态评估与剩余寿命预测服务

这是一个可直接在主机运行的纯后端 Node.js + TypeScript 项目，不依赖 Docker、数据库、Redis、Kafka 或云服务。业务状态默认写入本地 `data/state.json`，演示数据由代码生成，适合离线测试和后续接入真实传感器数据。

## 已实现业务

- 发动机档案与型号配置
- 飞行架次和多传感器时序导入
- 时间戳、单位、范围和单调性校验
- 导入顺序守卫：迟到/乱序批次稳定拒绝并进入持久化隔离区，重复提交幂等折叠，存储序列始终全局有序且唯一
- 缺失值线性插值与异常点剔除
- 飞行阶段工况归一化
- 排气温度裕度、燃油效率、振动风险、滑油压力裕度计算
- 传感器漂移和突变检测
- 发动机健康评分与状态分级
- 部件级风险排序
- 基于退化趋势的剩余寿命估算
- 预测置信区间与解释性证据
- 维修事件回灌和风险修正
- 传感器数据按时间顺序重放
- 维护窗口推演
- 模型版本比较
- 告警事件、审计轨迹和本地结果导出

## 运行

```bash
npm install
npm run build
npm test
npm run demo
npm start
```

服务默认监听 `http://127.0.0.1:6195`。

## 主要 API

```text
GET  /api/health
GET  /api/models
POST /api/engines/import
GET  /api/engines/:id
GET  /api/engines/:id/telemetry
POST /api/engines/:id/health-assessment
POST /api/engines/:id/rul-prediction
POST /api/engines/:id/replay
GET  /api/replay/jobs/:id
POST /api/engines/:id/maintenance-simulation
POST /api/models/compare
GET  /api/engines/:id/risk-events
GET  /api/engines/:id/quarantine
GET  /api/audit/:engineId
```

## 遥测顺序保证

样本唯一键为 `(engineId, timestamp, cycle)`，合法序列要求时间戳与 cycle 同时单调前进：

- **批次内传输乱序**：同一批次中先到 08:10/cycle 1764、后到 08:00/cycle 1763 会自动排序后正常接收。
- **迟到批次（跨提交乱序）**：已提交到 08:10/cycle 1764 后再提交 08:00/cycle 1763，该样本被拒绝并写入持久化隔离区，接口返回 `409`；同批的其他合法样本照常入库可用。
- **重复提交**：键与测量内容完全相同的重复样本幂等折叠（返回 `200`，计数为 `duplicateTelemetry`），不会产生第二条数据，也不会用零间隔掩盖缺失区间；同键但内容冲突的提交进入隔离区。
- **读取与重启**：存储和所有读取路径只暴露按 `(engineId, timestamp, cycle)` 排序且键唯一的规范序列；服务重启加载历史文件时同样执行去重与乱序隔离，不会因后续读取制造新的乱序。
- 校验层不再静默重排，任何倒退样本都会产生 `order_violation` 异常标记并从评估中剔除，退化斜率与缺失区间判断因此保持稳定。

隔离样本可通过 `GET /api/engines/:id/quarantine?reason=order_violation` 查询。

## 示例

```bash
curl http://127.0.0.1:6195/api/health
curl http://127.0.0.1:6195/api/engines/ENG-DEMO-001/health-assessment
curl -X POST http://127.0.0.1:6195/api/engines/ENG-DEMO-001/rul-prediction \
  -H 'content-type: application/json' \
  -d '{"horizonCycles":120}'
```
