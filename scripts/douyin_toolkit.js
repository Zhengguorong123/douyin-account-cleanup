/*
 * 抖音页面内清理工具（window.DY）
 * 用法：在已登录的 douyin.com 页面执行一次本文件，然后调用 DY.xxx()
 * 所有写操作默认 dryRun:true（只统计不删除），必须显式传 {dryRun:false}
 * 依赖：页面自身的 secsdk 自动签名，不要脱离页面运行。
 */
(function () {
  'use strict';
  if (window.DY && window.DY.__v === 1) return;

  const BASE = 'https://www.douyin.com';
  const Q =
    'device_platform=webapp&aid=6383&channel=channel_pc_web' +
    '&pc_client_type=1&version_code=170400&version_name=17.4.0' +
    '&cookie_enabled=true&platform=PC';
  const FORM = { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const state = {
    job: '',
    running: false,
    stop: false,
    ok: 0,
    fail: 0,
    pages: 0,
    note: '',
    err: '',
    startedAt: 0,
  };

  function reset(job) {
    state.job = job;
    state.running = true;
    state.stop = false;
    state.ok = 0;
    state.fail = 0;
    state.pages = 0;
    state.note = '';
    state.err = '';
    state.startedAt = Date.now();
  }

  function done() {
    state.running = false;
  }

  async function get(path) {
    const r = await fetch(BASE + path, { credentials: 'include' });
    const t = await r.text();
    let j = null;
    try { j = JSON.parse(t); } catch (e) { /* keep null */ }
    return { http: r.status, raw: t, json: j };
  }

  async function post(path, body) {
    const r = await fetch(BASE + path, {
      method: 'POST',
      credentials: 'include',
      headers: FORM,
      body: body || '',
    });
    const t = await r.text();
    let j = null;
    try { j = JSON.parse(t); } catch (e) { /* keep null */ }
    return { http: r.status, raw: t, json: j };
  }

  function cookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }

  function uifidHeader() {
    const v = cookie('UIFID');
    return v ? { uifid: v } : {};
  }

  async function profile() {
    const r = await get('/aweme/v1/web/user/profile/self/?' + Q);
    if (!r.json || r.json.status_code !== 0 || !r.json.user) {
      throw new Error('profile failed: ' + r.http + ' ' + (r.json ? r.json.status_code : r.raw.slice(0, 60)));
    }
    return r.json.user;
  }

  /* ---------------- 点赞 ---------------- */

  async function scanLikes(maxPages) {
    const u = await profile();
    const sec = u.sec_uid;
    let cursor = '0';
    let pages = 0;
    const seen = new Set();
    while (pages < (maxPages || 200)) {
      const r = await get(
        '/aweme/v1/web/aweme/favorite/?' + Q +
        '&sec_user_id=' + encodeURIComponent(sec) +
        '&max_cursor=' + cursor + '&min_cursor=0&count=50&publish_video_strategy_type=2'
      );
      const j = r.json || {};
      if (j.status_code !== 0) throw new Error('likes list status ' + j.status_code);
      for (const a of j.aweme_list || []) seen.add(String(a.aweme_id));
      pages++;
      if (j.has_more !== 1 || !j.max_cursor) break;
      if (String(j.max_cursor) === cursor) break;
      cursor = String(j.max_cursor);
      await sleep(120);
    }
    return { count: seen.size, pages };
  }

  async function runLikes(opts) {
    reset('likes');
    const dryRun = opts.dryRun !== false;
    const delay = opts.delay || 350;
    const batch = opts.batch || 50;
    try {
      const u = await profile();
      const sec = u.sec_uid;
      if (dryRun) {
        const r = await scanLikes(opts.maxPages || 200);
        state.note = 'dry-run: 待取消 ' + r.count + ' 条（' + r.pages + ' 页）';
        return done();
      }
      let lastFirst = '';
      let stuck = 0;
      for (let i = 0; i < (opts.maxBatches || 400) && !state.stop; i++) {
        const r = await get(
          '/aweme/v1/web/aweme/favorite/?' + Q +
          '&sec_user_id=' + encodeURIComponent(sec) +
          '&max_cursor=0&min_cursor=0&count=' + batch + '&publish_video_strategy_type=2'
        );
        const j = r.json || {};
        if (j.status_code !== 0) { state.err = 'list ' + j.status_code; break; }
        const list = j.aweme_list || [];
        if (!list.length) { state.note = 'empty'; break; }
        const first = String(list[0].aweme_id);
        if (first === lastFirst) stuck++; else stuck = 0;
        if (stuck > 3) { state.note = 'stuck'; break; }
        lastFirst = first;

        const ids = list.map((a) => String(a.aweme_id));
        const map = {};
        list.forEach((a) => { map[String(a.aweme_id)] = a.aweme_type === 68 ? 2 : 0; });
        const p = new URLSearchParams();
        p.set('aweme_ids', ids.join(','));
        p.set('item_type_map', JSON.stringify(map));
        const c = await post('/aweme/v1/web/cancel/item/digg/multi/?' + Q, p);
        const cj = c.json || {};
        if (c.http === 200 && cj.status_code === 0) {
          state.ok += ids.length - (cj.fatal_ids || []).length;
          state.fail = 0;
        } else {
          state.fail++;
          state.err = 'cancel ' + (cj.status_code || c.http);
          if (state.fail > 3) break;
        }
        state.pages++;
        await sleep(delay);
      }
    } catch (e) {
      state.err = String(e.message || e).slice(0, 120);
    }
    done();
  }

  /* ---------------- 收藏 ---------------- */

  function favListPath(cursor) {
    let p = '/aweme/v1/web/aweme/listcollection/?' + Q + '&publish_video_strategy_type=2';
    if (cursor) p += '&cursor=' + cursor;
    return p;
  }

  async function scanFavorites(maxPages) {
    let cursor = '';
    let pages = 0;
    let count = 0;
    while (pages < (maxPages || 300)) {
      const r = await post(favListPath(cursor), '');
      const j = r.json || {};
      if (j.status_code !== 0) throw new Error('favorites list status ' + j.status_code);
      count += (j.aweme_list || []).length;
      pages++;
      const c = j.cursor;
      if (j.has_more !== 1 || !c) break;
      const next = String(c);
      if (next === cursor) break;
      cursor = next;
      await sleep(120);
    }
    return { count, pages };
  }

  async function cancelFavIds(ids) {
    const p = new URLSearchParams();
    p.set('aweme_ids', ids.join(','));
    p.set('aweme_type_map', JSON.stringify(Object.fromEntries(ids.map((x) => [x, 0]))));
    return post('/aweme/v1/web/aweme/cancel/collect/multi/?' + Q, p);
  }

  async function runFavorites(opts) {
    reset('favorites');
    const dryRun = opts.dryRun !== false;
    const delay = opts.delay || 220;
    try {
      if (dryRun) {
        const r = await scanFavorites(opts.maxPages || 300);
        state.note = 'dry-run: 待取消 ' + r.count + ' 条（' + r.pages + ' 页）';
        return done();
      }
      for (let pass = 0; pass < (opts.passes || 3) && !state.stop; pass++) {
        let cursor = '';
        let deleted = 0;
        for (let page = 0; page < (opts.maxPages || 300) && !state.stop; page++) {
          const r = await post(favListPath(cursor), '');
          const j = r.json || {};
          if (j.status_code !== 0) { state.err = 'list ' + j.status_code; break; }
          const ids = (j.aweme_list || []).map((a) => String(a.aweme_id));
          if (ids.length) {
            const c = await cancelFavIds(ids);
            const cj = c.json || {};
            if (c.http === 200 && cj.status_code === 0) {
              deleted += ids.length;
              state.ok += ids.length;
              state.fail = 0;
            } else {
              state.fail++;
              state.err = 'cancel ' + (cj.status_code || c.http);
              if (state.fail > 3) break;
            }
            state.pages++;
            await sleep(delay);
          }
          const next = j.cursor ? String(j.cursor) : '';
          if (j.has_more !== 1 || !next || next === cursor) break;
          cursor = next;
        }
        if (deleted === 0) break;
      }
    } catch (e) {
      state.err = String(e.message || e).slice(0, 120);
    }
    done();
  }

  async function runMusic(opts) {
    reset('music');
    const dryRun = opts.dryRun !== false;
    try {
      let cursor = '0';
      const seen = new Set();
      for (let page = 0; page < 100 && !state.stop; page++) {
        const r = await get('/aweme/v1/web/music/listcollection/?cursor=' + cursor + '&count=20&' + Q);
        const j = r.json || {};
        if (j.status_code !== 0) { state.err = 'list ' + j.status_code; break; }
        const list = j.mc_list || [];
        for (const m of list) seen.add(String(m.id_str || m.id));
        state.pages++;
        if (dryRun) {
          if (j.has_more !== 1 || !j.cursor || String(j.cursor) === cursor) break;
          cursor = String(j.cursor);
          await sleep(120);
          continue;
        }
        for (const m of list) {
          if (state.stop) break;
          const q = new URLSearchParams();
          q.set('action', '0');
          q.set('music_id', String(m.id_str || m.id));
          const c = await post('/aweme/v1/web/music/collect/?' + Q, q);
          const cj = c.json || {};
          if (c.http === 200 && cj.status_code === 0) { state.ok++; state.fail = 0; }
          else { state.fail++; state.err = 'cancel ' + (cj.status_code || c.http); if (state.fail > 3) break; }
          await sleep(opts.delay || 250);
        }
        if (j.has_more !== 1 || !j.cursor || String(j.cursor) === cursor) break;
        cursor = String(j.cursor);
      }
      if (dryRun) state.note = 'dry-run: 音乐收藏 ' + seen.size + ' 首';
    } catch (e) {
      state.err = String(e.message || e).slice(0, 120);
    }
    done();
  }

  async function runMixes(opts) {
    reset('mixes');
    const dryRun = opts.dryRun !== false;
    try {
      let cursor = '0';
      const seen = new Set();
      for (let page = 0; page < 100 && !state.stop; page++) {
        const r = await get('/aweme/v1/web/mix/listcollection/?cursor=' + cursor + '&count=20&' + Q);
        const j = r.json || {};
        if (j.status_code !== 0) { state.err = 'list ' + j.status_code; break; }
        const list = j.mix_infos || [];
        for (const m of list) seen.add(String(m.mix_id));
        state.pages++;
        if (!dryRun && list.length) {
          const q = new URLSearchParams();
          q.set('mix_ids', list.map((m) => String(m.mix_id)).join(','));
          const c = await post('/aweme/v1/web/mix/cancel/collect/multi/?' + Q, q);
          const cj = c.json || {};
          if (c.http === 200 && cj.status_code === 0) { state.ok += list.length; state.fail = 0; }
          else { state.fail++; state.err = 'cancel ' + (cj.status_code || c.http); if (state.fail > 3) break; }
          await sleep(opts.delay || 250);
        }
        if (j.has_more !== 1 || !j.cursor || String(j.cursor) === cursor) break;
        cursor = String(j.cursor);
      }
      if (dryRun) state.note = 'dry-run: 合集收藏 ' + seen.size + ' 个';
    } catch (e) {
      state.err = String(e.message || e).slice(0, 120);
    }
    done();
  }

  /* ---------------- 关注 ---------------- */

  function followingPath(uid, sec, maxTime) {
    return '/aweme/v1/web/user/following/list/?' + Q +
      '&user_id=' + encodeURIComponent(uid) +
      '&sec_user_id=' + encodeURIComponent(sec) +
      '&offset=0&min_time=0&count=20&source_type=1&gps_access=0&address_book_access=0' +
      '&max_time=' + maxTime;
  }

  async function runFollowing(opts) {
    reset('following');
    const dryRun = opts.dryRun !== false;
    const delay = opts.delay || 500;
    try {
      const me = await profile();
      if (dryRun) {
        const r = await get(followingPath(me.uid, me.sec_uid, '0'));
        const j = r.json || {};
        const page = j.followings || [];
        state.note =
          'dry-run 抽样首页：' + page.length + ' 人，其中非互关 ' +
          page.filter((x) => x.follower_status === 0).length +
          '；账号关注总数 ' + me.following_count +
          '（正式执行会循环到清空，dry-run 不逐页枚举以免几百次请求）';
        return done();
      }
      let maxTime = '0';
      let lastSig = '';
      let stall = 0;
      for (let round = 0; round < 200 && !state.stop; round++) {
        const r = await get(followingPath(me.uid, me.sec_uid, maxTime));
        const j = r.json || {};
        if (j.status_code !== 0) { state.err = 'list ' + j.status_code; break; }
        const list = j.followings || [];
        if (!list.length) { state.note = 'empty'; break; }
        const sig = list.map((u) => u.uid).join(',');
        if (sig === lastSig) {
          stall++;
          if (stall > 4) { state.note = 'stall'; break; }
          maxTime = String(j.max_time);
          await sleep(300);
          continue;
        }
        lastSig = sig;
        stall = 0;
        const targets = list.filter((u) => u.follower_status === 0);
        if (!targets.length) { maxTime = String(j.max_time); await sleep(250); continue; }
        for (const t of targets) {
          if (state.stop) break;
          const q = new URLSearchParams();
          q.set('type', '0');
          q.set('user_id', String(t.uid));
          const c = await post('/aweme/v1/web/commit/follow/user/?' + Q, q);
          const cj = c.json || {};
          if (c.http === 200 && cj.status_code === 0 && cj.follow_status === 0) {
            state.ok++;
            state.fail = 0;
          } else {
            state.fail++;
            state.err = 'unfollow ' + (cj.status_code || c.http);
            if (state.fail > 3) { state.stop = true; break; }
          }
          await sleep(delay);
          if (state.ok > 0 && state.ok % 50 === 0) await sleep(2500);
        }
        maxTime = '0';
        state.pages++;
      }
    } catch (e) {
      state.err = String(e.message || e).slice(0, 120);
    }
    done();
  }

  /* ---------------- 对外 ---------------- */

  const DY = {
    __v: 1,
    async check() {
      const u = await profile();
      const likes = await get(
        '/aweme/v1/web/aweme/favorite/?' + Q +
        '&sec_user_id=' + encodeURIComponent(u.sec_uid) +
        '&max_cursor=0&min_cursor=0&count=50&publish_video_strategy_type=2'
      );
      return {
        ok: true,
        nick: u.nickname,
        uid: u.uid,
        sec_uid: u.sec_uid,
        favoriting_count: u.favoriting_count,
        following_count: u.following_count,
        follower_count: u.follower_count,
        likes_page0: ((likes.json && likes.json.aweme_list) || []).length,
      };
    },
    clearLikes(opts) { runLikes(opts || {}); return 'started:likes dryRun=' + ((opts && opts.dryRun) !== false); },
    clearFavorites(opts) { runFavorites(opts || {}); return 'started:favorites dryRun=' + ((opts && opts.dryRun) !== false); },
    clearMusic(opts) { runMusic(opts || {}); return 'started:music'; },
    clearMixes(opts) { runMixes(opts || {}); return 'started:mixes'; },
    clearFollowing(opts) { runFollowing(opts || {}); return 'started:following'; },
    report() { return Object.assign({}, state, { elapsed: state.startedAt ? Date.now() - state.startedAt : 0 }); },
    stop() { state.stop = true; return 'stopping'; },
  };

  window.DY = DY;
  return 'DY ready';
})();
