# Violet Map

pnpm workspace 单仓：`@violet-map/core`（纯算法）/ `@violet-map/assets`（资源提取）/ `@violet-map/server`（Hono）/ `@violet-map/web`（播放器）/ `@violet-map/admin`（后台）。

## 准备

1. `pnpm install`
2. 准备原版资源（两种方式任选）：

   **方式 A：使用 CLI 自动提取（推荐）**

   ```bash
   # 列出可用版本
   pnpm --filter @violet-map/assets dev list-versions

   # 提取指定版本的资源
   pnpm --filter @violet-map/assets dev extract --version 1.21.4 --output packages/server/data/assets
   ```

   **方式 B：手动从客户端 jar 解出**（注意资源文件受版权保护、仅限本地个人使用）

   ```bash
   mkdir -p packages/server/data/assets
   cd packages/server/data/assets
   unzip <.minecraft>/versions/1.20.4/1.20.4.jar 'assets/*'
   mv assets/* . && rmdir assets
   ```

   最终结构：`packages/server/data/assets/minecraft/{blockstates,models,textures}`

   自定义资源包：解出后追加目录，用 `ASSETS_DIRS=dirA,dirB` 传入（后者覆盖前者）。

3. 世界存档放入 `packages/server/data/worlds/<名字>/`（含 `region/`、`DIM-1/`、`DIM1/`），
   或启动后在管理后台上传 .mca / 单区块 NBT。

## 运行

```bash
pnpm dev
```

- 服务器 <http://localhost:8787>
- 播放器 <http://localhost:5173> （URL 支持 `?x=&y=&z=` 指定出生点）
- 后台   <http://localhost:5174>

环境变量：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `8787` | 服务器端口 |
| `WORLDS_DIR` | `data/worlds` | 世界存档目录 |
| `ASSETS_DIRS` | `data/assets` | 资源目录（逗号分隔，后覆盖前） |
| `DATA_DIR` | `data` | 运行时数据目录 |
| `MC_VERSION` | `1.20.4` | minecraft-data 版本号 |

## CLI 工具（@violet-map/assets）

```bash
pnpm --filter @violet-map/assets dev --help
```

| 命令 | 说明 |
|------|------|
| `list-versions` | 列出所有可用的 release 版本 |
| `extract --version <id> --output <dir>` | 提取指定版本资源 |
| `extract-all --min-version <id>` | 提取所有 ≥ 版本资源 |
| `generate-biomes --version <id>` | 生成 biomes.json |
| `generate-dimensions` | 生成 dimensions.json |

## 包结构

| 包 | 用途 |
|----|------|
| `@violet-map/core` | 纯算法：NBT 解析、模型烘焙、网格化、光照烘焙、LOD |
| `@violet-map/assets` | CLI 工具：从 Mojang 源提取资源、生成数据文件 |
| `@violet-map/server` | Hono 服务器：区块 API、资源 API、上传 |
| `@violet-map/web` | Three.js 播放器：Web Worker 网格化、WASD 飞行 |
| `@violet-map/admin` | React 管理后台：世界浏览、上传、群系编辑器 |

## 已知限制（v1）

- 仅支持 1.18+ 区块格式（sections + block_states palette）。
- 不渲染实体/方块实体；无 uvlock；群系着色为逐方块采样（未做半径混合）。
- 存档无光照数据时的烘焙光照按单列计算，区块边界的洞穴可能有轻微光照接缝。
- 流体为简化渲染（无流向斜面）；动画贴图取第一帧。
