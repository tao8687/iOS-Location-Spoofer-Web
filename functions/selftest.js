/**
 * iOS Location Spoofer Web
 *
 * Copyright (c) 2026 akudamatata (https://github.com/akudamatata/iOS-Location-Spoofer-Web)
 * Licensed under CC BY-NC-SA 4.0
 * ⚠️【特别声明】：本项目完全免费开源，严禁以任何形式进行二次售卖、转售、商业收费代搭建！
 */

/**
 * 自检端点：/selftest
 *
 * 用于在手机上快速判断「模块到底有没有生效」，避免无头排查。
 * 会依次验证：
 *   1. TOKEN 鉴权是否通过
 *   2. KV 中是否已保存坐标（锁定位置是否成功落库）
 *   3. /loc.json 是否能被小火箭脚本正常读取（返回 200 + 合法 JSON + 坐标合法）
 *   4. location-spoofer.js 是否可访问（脚本本体是否 200）
 *   5. ios-location-spoofer.sgmodule 是否可访问且已正确注入域名/Token
 *
 * 用法：浏览器打开  https://<你的域名>/selftest?token=<你的Token>
 */

import { authOk, jsonResponse, errorResponse, corsHeaders, DEFAULT_LOC } from './_utils.js';

export async function onRequestGet(context) {
  const { request, env } = context;

  if (!authOk(request, env)) {
    return errorResponse('unauthorized', 401);
  }

  const origin = new URL(request.url).origin;
  const checks = [];
  let allOk = true;

  // 1. 鉴权
  checks.push({ name: 'Token 鉴权', ok: true, detail: '通过' });

  // 2. KV 坐标落库
  let loc = DEFAULT_LOC;
  let kvBound = false;
  if (env.SPOOFER_DATA) {
    kvBound = true;
    loc = await env.SPOOFER_DATA.get('loc', { type: 'json' }) || DEFAULT_LOC;
  }
  const lat = Number(loc.latitude);
  const lng = Number(loc.longitude);
  const coordsValid =
    Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
  const isDefault = lat === DEFAULT_LOC.latitude && lng === DEFAULT_LOC.longitude;
  checks.push({
    name: 'KV 绑定 (SPOOFER_DATA)',
    ok: kvBound,
    detail: kvBound ? '已绑定' : '未绑定！坐标无法保存，请回到 Cloudflare 绑定 KV 命名空间'
  });
  checks.push({
    name: '坐标已落库',
    ok: coordsValid && !isDefault,
    detail: coordsValid
      ? (isDefault
        ? '当前仍是默认坐标（39.90872, 116.39748）——你还没在面板点过「锁定」'
        : `${lat}, ${lng}`)
      : '坐标非法，请重新锁定位置'
  });

  // 3. /loc.json 可读性（小火箭脚本就是通过它拿坐标）
  const token = new URL(request.url).searchParams.get('token') || '';
  try {
    const res = await fetch(origin + '/loc.json?token=' + encodeURIComponent(token));
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (e) { /* ignore */ }
    checks.push({
      name: '/loc.json 可读',
      ok: res.status === 200 && parsed && typeof parsed.latitude === 'number',
      detail: res.status === 200
        ? `HTTP 200，返回坐标 ${parsed ? parsed.latitude + ', ' + parsed.longitude : '(非 JSON)'}`
        : `HTTP ${res.status} ${text.slice(0, 80)}`
    });
  } catch (err) {
    checks.push({ name: '/loc.json 可读', ok: false, detail: '请求失败: ' + err.message });
  }

  // 4. 脚本本体可访问
  try {
    const res = await fetch(origin + '/location-spoofer.js');
    const text = await res.text();
    const hasEntry = text.includes('runShadowrocket');
    checks.push({
      name: 'location-spoofer.js 可访问',
      ok: res.status === 200 && hasEntry,
      detail: res.status === 200
        ? `HTTP 200，${(text.length / 1024).toFixed(1)} KB${hasEntry ? '' : '（内容异常）'}`
        : `HTTP ${res.status}`
    });
  } catch (err) {
    checks.push({ name: 'location-spoofer.js 可访问', ok: false, detail: '请求失败: ' + err.message });
  }

  // 5. 模块文件可访问且已注入
  try {
    const res = await fetch(origin + '/ios-location-spoofer.sgmodule?token=' + encodeURIComponent(token));
    const text = await res.text();
    const host = new URL(origin).host;
    // 模块里的 script-path / configUrl 用的是 host（不含协议），因此按 host 判断
    const injected = text.includes(host) && !text.includes('你的域名');
    const hasMitm = /hostname\s*=\s*%APPEND%/.test(text);
    const hasScript = /\[Script\]/.test(text);
    checks.push({
      name: '模块文件注入正确',
      ok: res.status === 200 && injected && hasMitm && hasScript,
      detail: res.status === 200
        ? (injected ? '域名已替换为 ' + host : '域名未替换（异常）') +
          (hasMitm ? ' / [MITM] 存在' : ' / [MITM] 缺失') +
          (hasScript ? ' / [Script] 存在' : ' / [Script] 缺失')
        : `HTTP ${res.status}`
    });
  } catch (err) {
    checks.push({ name: '模块文件注入正确', ok: false, detail: '请求失败: ' + err.message });
  }

  for (const c of checks) if (!c.ok) allOk = false;

  return jsonResponse({
    ok: allOk,
    origin,
    currentLocation: loc,
    checks,
    hints: allOk ? [] : [
      '若上面全部 ✅ 但定位仍不生效，请检查：',
      '1) Shadowrocket → 设置 → HTTPS 解密 → 是否已开启并生成 CA 证书',
      '2) iPhone → 设置 → 通用 → 关于本机 → 证书信任设置 → Shadowrocket 证书是否「完全信任」',
      '3) iOS 26+ 的 locationd 会缓存定位结果，需重启设备才会刷新',
      '4) iOS 27 beta 6+ 系统已对 gs-loc 开启证书固定(Pinning)，所有 MITM 方案均会失效'
    ]
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders()
  });
}
