---
name: douyin-account-cleanup
description: 在已登录的抖音网页版里批量取消点赞（喜欢）、清空收藏（视频/音乐/合集/短剧/收藏夹）和取关非互关用户。当用户提出“清空喜欢/点赞”“取消所有收藏”“批量取关/清理非互关”“账号清理”“Douyin bulk unlike / clear all favorites / unfollow non-mutual”等需求时使用；也用于排查 403 ArgusSecurityPlugin、翻页只前进一条、图文点赞删不掉、取消收藏后计数不清零等问题。
---

# 抖音账号批量清理（点赞 / 收藏 / 非互关）

面向“把自己的抖音账号清干净”的完整流程。核心只有一句话：**所有写操作都在已登录的网页版页面里用同源 `fetch` 发，让页面自带的 secsdk 去签名**；不要在 Node/Python 里直接打 API，也不要拿旧 cookie 重放。

## 0. 为什么不能直接发 HTTP 请求

2026 年 10 月的网页版加了 Argus 风控插件，三种典型报错按顺序出现：

| 请求缺少的东西 | 返回 |
|---|---|
| `uifid` 参数 / 请求头 | `403 Blocked by ArgusSecurityPlugin Uifid Not Found` |
| `x-secsdk-web-signature` + `timestamp` | `403 ... Signature Not Found` |
| 签名是旧的 / 别的会话的 | `403 ... Sign Invalid` |

`x-secsdk-web-signature` 由页面里的 secsdk 在**发送瞬间**按当前会话生成，绑定路径和时间，不能离线计算、不能回放（回放会得到 `Sign Invalid`）。所以唯一稳的做法是：打开真实浏览器 → 登录 → 在页面上下文里 `fetch('/aweme/v1/...')`，SDK 会自动补 `a_bogus`、`msToken`、`uifid`、`timestamp`、`x-secsdk-web-signature`。

> 项目里的 `static/dy_ab.js` 这类本地 `a_bogus` 生成器只解决一半问题：`profile/self` 能通，列表/写接口仍会被 Argus 拦。不要在这条路上耗时间。

## 1. 建立可执行环境

前置：Node 18+、`agent-browser` 已安装（`npm i -g agent-browser && agent-browser install`）。

```powershell
# 1) 打开有头浏览器（用户要能看见、能扫码）
agent-browser open --headed https://www.douyin.com/user/self

# 2) 让用户完成登录（扫码 / 短信身份验证）
#    登录后先清一次旧 cookie 再刷新，避免半登录态
agent-browser cookies clear
agent-browser reload
```

登录后**必须**先验证会话，返回 `status_code: 0` 才能继续：

```powershell
agent-browser eval "(async()=>{const r=await fetch('/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383&channel=channel_pc_web',{credentials:'include'});const j=await r.json();return JSON.stringify({sc:j.status_code,msg:j.status_msg,nick:j.user&&j.user.nickname,uid:j.user&&j.user.uid,sec:j.user&&j.user.sec_uid,fav:j.user&&j.user.favoriting_count,following:j.user&&j.user.following_count})})()"
```

- `status_code: 0` + 有 `nickname` → 可用。
- `status_code: 8` / `status_msg: "用户未登录"` → 会话已失效（被踢或风控），**只能重新扫码登录**，换/补 cookie 无效。
- 大量写操作后重新登录，抖音常会要求「身份验证」短信，这不是封号，按提示收短信即可。

统一请求约定（下文所有片段都遵守）：

- 一律用**相对路径**（`/aweme/v1/...`），同源，`credentials:'include'`。
- 只带必要参数，不要自作聪明加 `x-tt-session-dtrait`、`uid=`、`x-secsdk-csrf-token` 等，加错反而 403。
- POST 统一 `Content-Type: application/x-www-form-urlencoded; charset=UTF-8`。
- 先小批量试跑（1 条），确认 `status_code: 0` 再放大。

## 2. 三个任务的标准流程

### 2.1 取消全部点赞（喜欢）

**列表**：`GET /aweme/v1/web/aweme/favorite/`
必带 `sec_user_id=<自己的sec_uid>`、`max_cursor`、`min_cursor=0`、`count=50`、`publish_video_strategy_type=2`。
返回 `aweme_list[]`（含 `aweme_id`、`aweme_type`）、`has_more`、`max_cursor`。

**取消**：`POST /aweme/v1/web/cancel/item/digg/multi/`
表单两个字段：

```
aweme_ids=id1,id2,...            # 逗号分隔，实测 50 条/次稳定
item_type_map={"id1":0,"id2":0} # 关键：视频 0，图文 2
```

`item_type_map` 是最大的坑：**图文作品（`aweme_type === 68`）必须映射成 `2`**。全填 `0` 时接口仍返回 `status_code:0`，但这些 id 会进入 `fatal_ids`，点赞根本没取消，表现就是“跑完了列表还剩一大半，而且全是图文”。

**循环策略**（不要预先枚举再删，边删边拉首页最稳）：

```
loop:
  page = GET favorite?max_cursor=0&count=50
  if page.aweme_list 为空 -> 结束
  ids = 前 50 条
  POST cancel/item/digg/multi  (type map: 68->2, 其它->0)
  if 成功: 继续（列表已收缩，首页自然是下一批）
  if 首页第一条连续 3 次没变 -> 停止并报告
  sleep 250~600ms
```

判定成功：`status_code === 0`；`fatal_ids` 里剩下的通常是作者已删/下架的失效作品，取消不掉，属于正常残留。

### 2.2 清空收藏（五个子类型都要清）

收藏不是一个接口，而是 **视频 / 音乐 / 合集 / 短剧 / 收藏夹** 五套，只清视频会留下另外四类。

#### A. 视频收藏

**列表**：`POST /aweme/v1/web/aweme/listcollection/`
查询串只放基础参数 + `publish_video_strategy_type=2`，**第一次请求绝对不要带 `cursor`**。

> 带 `cursor=0` 会命中一段只剩 `disabled_item_ids` 的“空窗页”，返回 `aweme_list: null`，看起来像已经清空，实际还有几百上千条。这是最容易误判的地方。

正确翻页：首次不带 cursor → 取响应里的 `cursor`（微秒时间戳）→ 带 `cursor=<值>` 取下一页 → 直到 `has_more !== 1`。

**取消**：`POST /aweme/v1/web/aweme/cancel/collect/multi/`
表单：`aweme_ids=id1,id2,...` + **`aweme_type_map={"id1":0,...}`**（注意字段名叫 `aweme_type_map`，不是 `item_type_map`）。

循环：每页拿到 20 条 → 一次批量取消 → 跟随 `cursor` 下一页。删完后**再跑 1~2 轮**（第一轮删头部会让后续页游标偏移），直到整轮一条都没删到。

#### B. 音乐收藏

```
GET  /aweme/v1/web/music/listcollection/?cursor=0&count=20
     -> mc_list[]，取消时用 id_str（id 是超长整数，JS Number 会丢精度）
POST /aweme/v1/web/music/collect/
     action=0&music_id=<id_str>
```

#### C. 合集收藏

```
GET  /aweme/v1/web/mix/listcollection/?cursor=0&count=20
     -> mix_infos[]，取 mix_id
POST /aweme/v1/web/mix/cancel/collect/multi/
     mix_ids=id1,id2,...        # 批量，实测 7~20 条/次
```

不要用 `/aweme/v1/web/mix/collect/`（单条旧接口），会返回 `status_code:0` 但 `status_msg:"url doesn't match"`，等于没删。

#### D. 短剧收藏

```
GET /aweme/v1/web/series/collections/?cursor=0&count=12  -> series_infos[]
```

多数账号为空；若非空，先在页面「收藏 → 短剧」里点一次取消，抓它的 XHR 拿真实取消端点，不要猜。

#### E. 收藏夹（文件夹）

```
GET /aweme/v1/web/collects/list/?cursor=0&count=10        -> collects_list[]（collects_id 用字符串，别用 Number）
GET /aweme/v1/web/collects/video/list/?collects_id=<id>&cursor=0&count=10 -> aweme_list[]
```

文件夹里的条目在全局取消视频收藏后会一并消失（文件夹会变成空壳）。**空文件夹不影响收藏计数**，需要删除时走 `/aweme/v1/web/collects/maintain/` 或页面上的「… → 删除收藏夹」。

#### 最稳的兜底：用页面自己的「批量管理」

在「收藏」页点「批量管理 → 全选 → 取消收藏 → 确认取消」，这是官方路径，天然覆盖当前子 tab 的所有条目。一边点一边用 `agent-browser network requests --filter "collect"` 看它发的真实请求，能直接拿到上面那些端点。合集那 28 个就是这么定位到 `mix/cancel/collect/multi` 的。

### 2.3 取关非互关用户

**列表**：`GET /aweme/v1/web/user/following/list/`
必带 `user_id=<数字uid>`、`sec_user_id=<自己的sec_uid>`、`max_time`、`min_time=0`、`count=20`、`source_type=1`、`gps_access=0`、`address_book_access=0`。
每条 `followings[]` 有 `uid`、`sec_uid`、`nickname`、`follower_status`：
**`follower_status === 1` = 互关，`=== 0` = 对方没回关（要取关的目标）**。

**取关**：`POST /aweme/v1/web/commit/follow/user/?<基础参数>&webid=<webid>`

```
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
uifid: <当前会话 uifid，从页面任意同源请求头里取>

type=0&user_id=<数字 uid>
```

实测可行版本就是「相对路径 + 基础参数 + `uifid` 头」，**不要**加 `uid=<32位hex>` 查询参数（会得到 `status_code:8 用户未登录`），也**不要**加 `x-secsdk-csrf-token`（会 403）。

**翻页的坑**：`max_time` 是“包含首条”的语义——把响应里的 `max_time` 原样传回去，只会前进 1 条；`offset` 完全被忽略，调 20/40 都返回同一页。所以不要做“按时间翻页再统一删”的方案。

**可行策略**（删完自然收缩）：

```
loop:
  page = GET following/list?max_time=0&count=20
  if 空 -> 结束
  targets = page.followings 里 follower_status === 0 的
  if targets 为空（整页都是互关）:
      max_time = page.max_time      # 跳过最上面这个互关
      continue
  for u in targets: POST commit/follow/user  (type=0, user_id=u.uid)
      每 50 个停 2.5s；每条间隔 400~600ms
```

停止条件：连续 3 次失败、HTTP 403、`status_code != 0`、页面返回登录失效（8）。

## 3. 参数与响应速查

完整字段、真实响应样例见 `references/endpoints.md`。最常用的判定：

- 点赞列表成功：`status_code:0` + `aweme_list` 数组。
- 取消点赞成功：`status_code:0` + `fatal_ids: []`（非空表示这几条没删掉）。
- 收藏列表成功：`status_code:0` + `aweme_list`（可能为 `null`，此时看 `cursor` 是否还有下一页）。
- 取消收藏成功：`status_code:0`。
- 取关成功：`status_code:0` + `follow_status:0`。
- 会话失效：`status_code:8` + `用户未登录`。

## 4. 节奏、风控与止损

- 点赞：50 条/请求，间隔 250~600ms，每 50 条暂停 2.5s。
- 收藏：20 条/页，每页一次批量取消，间隔 180~250ms。
- 取关：1 条/请求，间隔 450~600ms，每 50 条暂停 2.5s。
- 单次会话写操作 **控制在 2000 条以内** 更安全；上万条极易触发：
  - 会话被踢（`status_code:8`），
  - 重新登录时强制「身份验证」短信，
  - 更严重的限流 / 封禁。
- 触发验证码 / 身份验证就**立刻停手**，让用户手动完成，不要尝试绕过。
- 完成后 24 小时内不要再做批量写操作。

## 5. 验收（必须做，别信计数）

`favoriting_count` 这类计数有缓存，可能延迟几分钟甚至一直不动，**以列表接口为准**：

```powershell
# 收藏四类 + 点赞 + 关注，应该全部为 0（关注只剩互关）
agent-browser eval "(async()=>{const b='/aweme/v1/web/';const q='device_platform=webapp&aid=6383&channel=channel_pc_web&pc_client_type=1&version_code=170400&version_name=17.4.0&cookie_enabled=true&platform=PC';const p=await (await fetch(b+'user/profile/self/?'+q,{credentials:'include'})).json();const v=await (await fetch(b+'aweme/listcollection/?publish_video_strategy_type=2&'+q,{method:'POST',credentials:'include',headers:{'content-type':'application/x-www-form-urlencoded'},body:''})).json();const m=await (await fetch(b+'music/listcollection/?cursor=0&count=20&'+q,{credentials:'include'})).json();const x=await (await fetch(b+'mix/listcollection/?cursor=0&count=20&'+q,{credentials:'include'})).json();const s=await (await fetch(b+'series/collections/?cursor=0&count=12&'+q,{credentials:'include'})).json();return JSON.stringify({fav:p.user.favoriting_count,video:(v.aweme_list||[]).length,music:(m.mc_list||[]).length,mix:(x.mix_infos||[]).length,series:(s.series_infos||[]).length,following:p.user.following_count})})()"
```

验收标准：

1. 视频 / 音乐 / 合集 / 短剧全部为 0；
2. 点赞首页 `aweme_list` 为空；
3. 关注列表里剩余条目 `follower_status` 全为 1；
4. 收藏夹即便还有文件夹，点进去也应显示「暂无内容」。

## 6. 排障入口

报错对照表、会话生命周期、cursor 细节、桌面端 / CDP 备选方案，见 `references/troubleshooting.md`。

## 7. 可直接用的页面内工具

`scripts/douyin_toolkit.js` 把上面三件事封装成 `window.DY`，**默认 dry-run**，只有显式 `dryRun:false` 才真的删。

> 不要用 `agent-browser eval (Get-Content ...)` 直接注入：脚本有 15KB，eval 参数过长会被截断或转义破坏（表现为 `SyntaxError: Invalid or unexpected token`）。用配套的 `scripts/inject.ps1` 分片注入。

```powershell
# 注入（在已登录页面执行一次；内部把脚本切成 1.8KB 的 base64 分片）
powershell -ExecutionPolicy Bypass -File scripts\inject.ps1

# 体检
agent-browser eval "(async()=>JSON.stringify(await DY.check()))()"

# 预演（只统计，不删）
agent-browser eval "DY.clearLikes({dryRun:true})"
agent-browser eval "DY.clearFavorites({dryRun:true})"
agent-browser eval "DY.clearFollowing({dryRun:true})"   # 关注只抽样首页，不做全量枚举

# 真跑（确认预演数字后）
agent-browser eval "DY.clearLikes({dryRun:false})"
agent-browser eval "DY.clearFavorites({dryRun:false})"
agent-browser eval "DY.clearMusic({dryRun:false})"      # 音乐
agent-browser eval "DY.clearMixes({dryRun:false})"      # 合集
agent-browser eval "DY.clearFollowing({dryRun:false})"

# 轮询 / 止损
agent-browser eval "JSON.stringify(DY.report())"
agent-browser eval "DY.stop()"
```

`DY.report()` 返回 `{job, running, ok, fail, pages, note, err, elapsed}`；`ok` 是已删除条数，`err` 非空即停。

工具只负责“跑”；启动前仍要按第 1 节确认 `status_code:0`，跑完按第 5 节验收。

## 8. 红线

- 只对**自己的账号**使用，且用户明确授权。
- 不做登录绕过、不破解验证码、不伪造签名。
- 不把 cookie / uifid / webid 写入仓库；`.env` 之类文件必须进 `.gitignore`。
- 写操作不可撤销，执行前必须让用户确认范围。
