# 接口参考（2026-10 实测）

所有请求都在 `https://www.douyin.com` 的**已登录页面**里以相对路径发出，`credentials:'include'`。
本文只记录验证过的字段；`…` 表示基础参数，见文末。

## 目录

1. [会话与账号](#1-会话与账号)
2. [点赞（喜欢）](#2-点赞喜欢)
3. [收藏：视频](#3-收藏视频)
4. [收藏：音乐](#4-收藏音乐)
5. [收藏：合集](#5-收藏合集)
6. [收藏：短剧](#6-收藏短剧)
7. [收藏夹（文件夹）](#7-收藏夹文件夹)
8. [关注 / 取关](#8-关注--取关)
9. [通用响应与状态码](#9-通用响应与状态码)
10. [基础参数与请求头](#10-基础参数与请求头)

---

## 1. 会话与账号

### `GET /aweme/v1/web/user/profile/self/`

| 参数 | 值 |
|---|---|
| `device_platform` | `webapp` |
| `aid` | `6383` |
| `channel` | `channel_pc_web` |

关键返回：

```json
{
  "status_code": 0,
  "user": {
    "uid": "2942717759592615",
    "sec_uid": "MS4wLjABAAAA...",
    "nickname": "Gwan.",
    "favoriting_count": 0,
    "following_count": 11,
    "follower_count": 20
  }
}
```

- `status_code: 8` + `status_msg: "用户未登录"` = 会话失效。
- `favoriting_count` 有缓存，可能滞后，验收以列表为准。
- 这个接口**不需要** `uifid`，是判断“还能不能干活”的最快探针。

---

## 2. 点赞（喜欢）

### `GET /aweme/v1/web/aweme/favorite/`

| 参数 | 值 / 说明 |
|---|---|
| `sec_user_id` | 自己的 `sec_uid`（必填，写死别人的会拿到别人的列表） |
| `max_cursor` | 第一页 `0`，后续用响应的 `max_cursor`（毫秒时间戳） |
| `min_cursor` | `0` |
| `count` | `50`（实测可用；18 是网页默认） |
| `publish_video_strategy_type` | `2` |

返回：

```json
{
  "status_code": 0,
  "aweme_list": [
    { "aweme_id": "7694932631481792335", "aweme_type": 68, "desc": "…" }
  ],
  "has_more": 1,
  "max_cursor": 1792309881000
}
```

`aweme_type`：`0` = 视频，`68` = 图文。

### `POST /aweme/v1/web/cancel/item/digg/multi/`

表单：

```
aweme_ids=7694932631481792335,7696203165432507579
item_type_map={"7694932631481792335":2,"7696203165432507579":0}
```

- `item_type_map` 的值：图文（`aweme_type=68`）→ `2`，视频 → `0`。
- 填错不会报错，只是把 id 塞进 `fatal_ids`，点赞保持原样。
- 实测 50 条/请求稳定。

返回：

```json
{ "status_code": 0, "status_msg": "", "fatal_ids": [] }
```

`fatal_ids` 非空 = 这几条没取消（多为作者已删/不可用）。

---

## 3. 收藏：视频

### `POST /aweme/v1/web/aweme/listcollection/`

查询串：`…&publish_video_strategy_type=2`，body 为空。

**第一次请求不要带 `cursor`。** 带 `cursor=0` 会返回：

```json
{ "status_code": 0, "aweme_list": null, "cursor": 1788437354, "has_more": 1,
  "disabled_item_ids": [7688230433386093018, ...] }
```

这是“只剩失效条目”的空窗页，不代表收藏清空。

不带 cursor 的正常返回：

```json
{
  "status_code": 0,
  "aweme_list": [ { "aweme_id": "7682423473112698121", ... } ],
  "cursor": 1787989506340240,
  "has_more": 1,
  "disabled_item_ids": []
}
```

- `cursor` 是**微秒**级时间戳，必须原样字符串回传。
- 翻页：首次不传 → 传响应 `cursor` → 直到 `has_more !== 1`。

### `POST /aweme/v1/web/aweme/cancel/collect/multi/`

表单：

```
aweme_ids=7682423473112698121,7681762942617934459
aweme_type_map={"7682423473112698121":0,"7681762942617934459":0}
```

字段名是 **`aweme_type_map`**（不是 `item_type_map`）。返回 `{"status_code":0}`。

实测一次 20 条（整页）稳定；400+ 条/轮、3 轮可以把 600+ 收藏清到 0。

---

## 4. 收藏：音乐

### `GET /aweme/v1/web/music/listcollection/?cursor=0&count=20`

返回 `mc_list[]`：

```json
{ "id": 7182851804189853698, "id_str": "7182851804189853698", "title": "Why Why Why", "author": "王嘉尔" }
```

**用 `id_str`**：`id` 超过 JS 安全整数范围，`Number` 会变成 `…854000`，拿它去删会删错/删不掉。

### `POST /aweme/v1/web/music/collect/`

表单：

```
action=0&music_id=7182851804189853698
```

返回：`{"status_code":0,"status_msg":"取消收藏"}`。

---

## 5. 收藏：合集

### `GET /aweme/v1/web/mix/listcollection/?cursor=0&count=20`

返回 `mix_infos[]`（`mix_id`、`mix_name`、`desc`、`ids`），以及 `cursor` / `has_more`。

### `POST /aweme/v1/web/mix/cancel/collect/multi/`

表单：

```
mix_ids=7642328043343579190,7207001807963293736
```

返回 `{"status_code":0}`。

> 不要用 `/aweme/v1/web/mix/collect/`：返回 `status_code:0` 但 `status_msg:"url doesn't match"`，实际没删。

---

## 6. 收藏：短剧

### `GET /aweme/v1/web/series/collections/?cursor=0&count=12`

返回 `series_infos[]`、`series_info`、`has_more`、`cursor`。

多数账号为空。非空时先在页面「收藏 → 短剧」点一次「取消收藏」，用 `agent-browser network requests --filter series` 抓真实取消端点，不要照搬合集的 `.../cancel/collect/multi/`。

---

## 7. 收藏夹（文件夹）

### `GET /aweme/v1/web/collects/list/?cursor=0&count=10`

返回 `collects_list[]`：

```json
{ "collects_id": "7657618631957878562", "collects_name": "穿搭（收一拍一）", "total_number": 3 }
```

`collects_id` 是字符串；一旦 `JSON.parse` 后当数字用会丢精度。

### `GET /aweme/v1/web/collects/video/list/?collects_id=<id>&cursor=0&count=10`

返回该文件夹下的 `aweme_list[]`。

- 全局取消视频收藏后，文件夹里的条目会一并消失，文件夹变空壳。
- 空文件夹不计入 `favoriting_count`。
- 删除文件夹：`POST /aweme/v1/web/collects/maintain/`（未完整验证）或页面「… → 删除收藏夹」。

---

## 8. 关注 / 取关

### `GET /aweme/v1/web/user/following/list/`

| 参数 | 值 |
|---|---|
| `user_id` | 自己的数字 uid |
| `sec_user_id` | 自己的 sec_uid |
| `max_time` | 第一页 `0`，之后见下方“坑” |
| `min_time` | `0` |
| `count` | `20`（上限，传 50/100 仍返回 20） |
| `source_type` | `1` |
| `gps_access` | `0` |
| `address_book_access` | `0` |

返回：

```json
{
  "status_code": 0,
  "followings": [
    { "uid": "108163246980", "sec_uid": "MS4w...", "nickname": "梁豆豆",
      "follow_status": 1, "follower_status": 0 }
  ],
  "has_more": true,
  "max_time": 1792500387
}
```

- `follower_status`：`1` 互关，`0` 未回关。
- **`max_time` 是“含首条”语义**：把它原样传回，只会前进 1 条。
- **`offset` 被完全忽略**：`offset=0/20/40` 返回同一页。
- 列表上限 20 条/页，`count` 调大无效。

### `POST /aweme/v1/web/commit/follow/user/`

查询串：基础参数 + `webid`（可选，建议带上页面当前值）。

请求头：

```
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
uifid: <当前会话 uifid>
```

表单：

```
type=0&user_id=108163246980
```

成功返回：

```json
{ "status_code": 0, "follow_status": 0 }
```

失败形态与原因：

| 现象 | 原因 |
|---|---|
| `403` 空 body | 用绝对 URL + 带了 `x-secsdk-csrf-token` / 旧 `uid` 参数 |
| `status_code:8 用户未登录` | query 里带了**别的会话**的 `uid=<32hex>` |
| `status_code:0` 但没取关 | 典型的参数被忽略，检查 `user_id` 是否是数字 uid（不是 sec_uid） |

---

## 9. 通用响应与状态码

| status_code | 含义 |
|---|---|
| `0` | 成功 |
| `5` | 参数/接口不匹配（常见于少了基础参数） |
| `8` | 用户未登录（会话失效） |

HTTP 层：

| 现象 | 含义 |
|---|---|
| `403 Blocked by ArgusSecurityPlugin ...` | 签名链路问题，回页面里发 |
| `403` 空 body | 请求头/参数组合被判定异常 |
| `404 Unsupported path(Janus)` | 路径写错（如把收藏列表写成 GET、把 `cancel/collect` 写成 `collect/cancel`） |
| `200` 但 `status_msg: "url doesn't match"` | 命中了旧接口，换批量接口 |

---

## 10. 基础参数与请求头

查询串（顺序不敏感，但建议固定）：

```
device_platform=webapp
aid=6383
channel=channel_pc_web
pc_client_type=1
pc_libra_divert=Windows
update_version_code=170400
support_h265=1
support_dash=1
version_code=170400
version_name=17.4.0
cookie_enabled=true
screen_width=2048
screen_height=1152
browser_language=zh-CN
browser_platform=Win32
browser_name=Edge
browser_version=155.0.0.0
browser_online=true
engine_name=Blink
engine_version=155.0.0.0
os_name=Windows
os_version=10
cpu_core_num=16
device_memory=32
platform=PC
downlink=10
effective_type=4g
round_trip_time=150
webid=<页面 webid，可选>
uifid=<会话 uifid，部分接口要>
```

页面自己发请求时还会带 `msToken`、`verifyFp`、`fp`、`a_bogus`、`timestamp`、`x-secsdk-web-signature` —— **这些不要手写**，页面内 `fetch` 会由 secsdk 补全。

请求头：

```
Content-Type: application/x-www-form-urlencoded; charset=UTF-8   # POST
Accept: application/json, text/plain, */*
uifid: <会话 uifid>                                               # 取关等写接口需要
```
