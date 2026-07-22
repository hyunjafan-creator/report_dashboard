// sugup_dashboard.js — 국내 증시 수급 대시보드 생성기
//   출력: ★Report_dashboards\수급대시보드_YYYY-MM-DD.html
//   실행: node sugup_dashboard.js  (옵션 없음, 매 실행 시 전체 갱신)
//
// 데이터 소스 (2026-07 기준 실제 접근 가능 여부 확인 완료)
//   1) 지수 실시간/당일    : 네이버 polling API (장중 실시간, 장마감 후 종가)
//   2) 지수 확정 종가       : KRX 오픈API idx (전영업일 확정치, 보조 표기)
//   3) 예탁금·신용잔고 90일 : 네이버금융 증시자금동향(sise_deposit) — 금투협 집계 재게시
//   4) 투자자별 순매수      : 네이버금융 투자자별매매동향(investorDealTrendDay) — KOSCOM 집계
//      ※ '사모'는 네이버 분류상 '투신(사모)'로 투신과 합산 제공됨
//   5) 외국인/기관 순매매 상위 : 네이버금융 sise_deal_rank_iframe
//   6) 반대매매             : 금융투자협회 FreeSIS — 무인증 API 차단 상태(잠금 카드 표시)
//   7) 사모/연기금 개별 상위 : KRX 정보데이터시스템 — 로그인제 전환(잠금 카드 표시)
const fs = require('fs');
const path = require('path');

const OUT_DIR = 'C:\\Users\\drago\\Downloads\\claude_work\\★Report_dashboards';
const KRX_CFG = 'C:\\Users\\drago\\Downloads\\claude_work\\krx_agent\\config.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// KRX 오픈API 인증키: 환경변수(클라우드/GitHub Actions) 우선, 없으면 로컬 config.json
function getKrxKey() {
  if (process.env.KRX_AUTH_KEY) return process.env.KRX_AUTH_KEY;
  try { return JSON.parse(fs.readFileSync(KRX_CFG, 'utf8').replace(/^﻿/, '')).authKey; } catch (e) { return null; }
}
// --outfile <경로>: 지정 시 해당 파일 하나만 출력 (GitHub Actions에서 sugup.html 생성용)
const OUTFILE = (() => { const i = process.argv.indexOf('--outfile'); return i >= 0 ? process.argv[i + 1] : null; })();

// ---------- 공용 유틸 ----------
async function getText(url, euckr) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  if (!euckr) return await res.text();
  const buf = Buffer.from(await res.arrayBuffer());
  return new TextDecoder('euc-kr').decode(buf);
}
const num = (s) => { const v = parseFloat(String(s).replace(/,/g, '')); return isNaN(v) ? null : v; };
const fmt = (v, d = 0) => v == null ? '-' : v.toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d });
const signCls = (v) => v > 0 ? 'up' : v < 0 ? 'dn' : 'fl';
const signTxt = (v, d = 0) => (v > 0 ? '+' : '') + fmt(v, d);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function ymd(d) { return d.toISOString().slice(0, 10).replace(/-/g, ''); }

// ---------- 1) 지수: 네이버 실시간 ----------
async function fetchRealtimeIndex() {
  const t = await getText('https://polling.finance.naver.com/api/realtime?query=SERVICE_INDEX:KOSPI,KOSDAQ');
  const j = JSON.parse(t);
  const out = {};
  for (const d of j.result.areas[0].datas) {
    out[d.cd] = {
      now: d.nv / 100, chg: d.cv / 100, rate: d.cr, state: d.ms, // OPEN=장중, CLOSE=마감
      high: d.hv / 100, low: d.lv / 100, amountM: d.aa, // aa: 거래대금(백만원)
    };
  }
  return out;
}

// ---------- 2) 지수 확정 종가: KRX 오픈API (전영업일) ----------
async function fetchKrxOfficialIndex() {
  const key = getKrxKey();
  if (!key) return null;
  const call = async (ep, basDd) => {
    try {
      const r = await fetch(`https://data-dbg.krx.co.kr/svc/apis/${ep}?basDd=${basDd}`, { headers: { AUTH_KEY: key } });
      const j = await r.json();
      for (const k of Object.keys(j)) if (Array.isArray(j[k])) return j[k];
      return [];
    } catch (e) { return []; }
  };
  // 최근 7일 역탐색으로 최신 확정치 확보
  let d = new Date();
  for (let i = 0; i < 8; i++) {
    const basDd = ymd(d);
    const w = d.getUTCDay();
    d = new Date(d.getTime() - 86400000);
    if (w === 0 || w === 6) continue;
    const [kospi, kosdaq] = await Promise.all([call('idx/kospi_dd_trd', basDd), call('idx/kosdaq_dd_trd', basDd)]);
    const k1 = kospi.find(r => r.IDX_NM === '코스피' && r.CLSPRC_IDX);
    const k2 = kosdaq.find(r => r.IDX_NM === '코스닥' && r.CLSPRC_IDX);
    if (k1 || k2) return { basDd, kospi: k1 || null, kosdaq: k2 || null };
  }
  return null;
}

// ---------- 3) 예탁금·신용잔고 (90영업일) ----------
async function fetchDepositCredit(days = 90) {
  // 행 구조: <td class="date">26.07.10</td> 뒤로 rate_up/rate_down 클래스 td 10개
  //          [예탁금, 예탁금증감, 신용잔고, 신용증감, 주식형, 증감, 혼합형, 증감, 채권형, 증감] (단위 억원)
  //          증감 부호는 셀의 rate_down 클래스로 판별
  const rows = [];
  const seen = new Set();
  for (let page = 1; page <= 8 && rows.length < days; page++) {
    const t = await getText(`https://finance.naver.com/sise/sise_deposit.naver?page=${page}`, true);
    const trs = t.split(/<tr/).slice(1);
    for (const tr of trs) {
      const dm = tr.match(/class="date"[^>]*>([\d.]+)</);
      if (!dm || seen.has(dm[1])) continue;
      const cells = [...tr.matchAll(/<td[^>]*class="(rate_up|rate_down)[^"]*"[^>]*>\s*([\d,]+)\s*<\/td>/g)]
        .map(m => ({ v: num(m[2]), down: m[1] === 'rate_down' }));
      if (cells.length >= 4) {
        seen.add(dm[1]);
        rows.push({
          date: dm[1],
          deposit: cells[0].v, depositChg: cells[1].down ? -cells[1].v : cells[1].v,
          credit: cells[2].v, creditChg: cells[3].down ? -cells[3].v : cells[3].v,
        });
      }
    }
  }
  return rows.slice(0, days); // 최신순
}

// ---------- 4) 투자자별 순매수 (일별, 페이지당 10행) ----------
async function fetchInvestorTrend(sosok, days = 90) { // '01' KOSPI, '02' KOSDAQ
  const bizdate = ymd(new Date());
  const out = []; const seen = new Set();
  for (let page = 1; page <= Math.ceil(days / 10) + 2 && out.length < days; page++) {
    const t = await getText(`https://finance.naver.com/sise/investorDealTrendDay.naver?bizdate=${bizdate}&sosok=${sosok}&page=${page}`, true);
    for (const tr of t.split(/<tr/).slice(1)) {
      const dm = tr.match(/class="date2?"[^>]*>([\d.]+)</);
      if (!dm || seen.has(dm[1])) continue;
      const nums = [...tr.matchAll(/<td[^>]*>\s*(-?[\d,]+)\s*<\/td>/g)].map(m => num(m[1]));
      if (nums.length >= 10) {
        seen.add(dm[1]);
        // 순서: 개인 외국인 기관계 금융투자 보험 투신(사모) 은행 기타금융 연기금등 기타법인
        out.push({
          date: dm[1], 개인: nums[0], 외국인: nums[1], 기관계: nums[2], 금융투자: nums[3],
          보험: nums[4], 투신사모: nums[5], 은행: nums[6], 기타금융: nums[7], 연기금등: nums[8], 기타법인: nums[9],
        });
      }
    }
  }
  return out.slice(0, days); // 최신순, [0]이 최근 영업일
}

// 일별 순매수 막대 + 누적 순매수 라인 차트 (억원)
function svgBarChart(asc /* 과거→최신 [{date, v}] */, { width = 560, height = 200 } = {}) {
  const pad = { l: 52, r: 56, t: 14, b: 24 };
  const IW = width - pad.l - pad.r, IH = height - pad.t - pad.b;
  const vals = asc.map(r => r.v);
  const mx = Math.max(...vals, 0), mn = Math.min(...vals, 0);
  const rng = (mx - mn) || 1;
  const x = (i) => pad.l + (i + 0.5) / asc.length * IW;
  const y = (v) => pad.t + IH - (v - mn) / rng * IH;
  const zero = y(0);
  const bw = Math.max(1.2, IW / asc.length * 0.65);
  const bars = asc.map((r, i) => {
    const yv = y(r.v);
    return `<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${Math.min(yv, zero).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0.8, Math.abs(yv - zero)).toFixed(1)}" fill="${r.v >= 0 ? '#f4516c' : '#3d8bfd'}"/>`;
  }).join('');
  // 누적선 (우측 독립 스케일)
  let s = 0; const cum = asc.map(r => (s += r.v));
  const cmx = Math.max(...cum, 0), cmn = Math.min(...cum, 0), crng = (cmx - cmn) || 1;
  const y2 = (v) => pad.t + IH - (v - cmn) / crng * IH;
  const cumLine = `<polyline points="${cum.map((v, i) => x(i).toFixed(1) + ',' + y2(v).toFixed(1)).join(' ')}" fill="none" stroke="#e2c04f" stroke-width="1.8" opacity="0.9"/>`;
  const xi = [0, Math.floor(asc.length / 2), asc.length - 1];
  const last = cum[cum.length - 1];
  return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <line x1="${pad.l}" y1="${zero.toFixed(1)}" x2="${pad.l + IW}" y2="${zero.toFixed(1)}" class="grid"/>
    ${bars}${cumLine}
    <text x="${pad.l - 6}" y="${(y(mx) + 4).toFixed(1)}" class="axl" text-anchor="end">${fmt(mx / 10000, 1)}조</text>
    <text x="${pad.l - 6}" y="${(y(mn) + 4).toFixed(1)}" class="axl" text-anchor="end">${fmt(mn / 10000, 1)}조</text>
    <text x="${pad.l + IW + 4}" y="${(y2(last) + 4).toFixed(1)}" class="axl" fill="#e2c04f">누적 ${fmt(last / 10000, 1)}조</text>
    ${xi.map(i => `<text x="${x(i).toFixed(1)}" y="${height - 6}" class="axl" text-anchor="${i === 0 ? 'start' : i === asc.length - 1 ? 'end' : 'middle'}">${asc[i].date}</text>`).join('')}
  </svg>`;
}

// ---------- 5) 외국인/기관 순매매 상위 ----------
async function fetchDealRank(sosok, gubun, type) { // gubun: 9000 외국인 / 1000 기관, type: buy/sell
  // iframe 안에 [이전 영업일, 최근 영업일] 두 날짜 섹션(sise_guide_date)이 순서대로 있음 → 마지막 섹션이 최신
  // 행: 종목링크 + <td class="number">수량(천주, 매도는 음수)</td><td class="number">금액(백만원)</td><td class="number">당일거래량(주)</td>
  const t = await getText(`https://finance.naver.com/sise/sise_deal_rank_iframe.naver?sosok=${sosok}&investor_gubun=${gubun}&type=${type}`, true);
  const secs = t.split(/sise_guide_date"?>/).slice(1);
  if (!secs.length) return { date: null, rows: [] };
  const last = secs[secs.length - 1];
  const date = (last.match(/^([\d.]+)/) || [])[1] || null;
  const out = [];
  for (const tr of last.split(/<tr/).slice(1)) {
    const cm = tr.match(/code=(\d{6})[^>]*>([^<]+)</);
    if (!cm) continue;
    const nums = [...tr.matchAll(/<td[^>]*class="number"[^>]*>\s*(-?[\d,]+)\s*<\/td>/g)].map(m => num(m[1]));
    if (nums.length >= 3) {
      out.push({ code: cm[1], name: cm[2].trim(), qtyK: Math.abs(nums[0]), amtM: Math.abs(nums[1]), vol: nums[2] });
    }
  }
  return { date, rows: out };
}

// ---------- 5.5) KRX 종목별 거래대금 (수급강도 분모용, 기준일 확정치) ----------
async function fetchKrxTradeValueMap(basDd) {
  const key = getKrxKey();
  if (!key) return {};
  const map = {};
  for (const ep of ['sto/stk_bydd_trd', 'sto/ksq_bydd_trd', 'etp/etf_bydd_trd']) {
    try {
      const r = await fetch(`https://data-dbg.krx.co.kr/svc/apis/${ep}?basDd=${basDd}`, { headers: { AUTH_KEY: key } });
      const j = await r.json();
      if (j.respCode) { console.log(`      KRX ${ep} 오류: ${j.respMsg} (${j.respCode})`); continue; }
      const rows = Object.values(j).find(Array.isArray) || [];
      for (const row of rows) if (row.ISU_CD) map[row.ISU_CD] = { trdval: num(row.ACC_TRDVAL), close: num(row.TDD_CLSPRC), flucRt: num(row.FLUC_RT) };
    } catch (e) { console.log(`      KRX ${ep} 실패: ${e.message}`); }
  }
  return map;
}

// KRX 접근 불가 시(해외IP 등) 폴백: 네이버 fchart 일별시세로 거래대금 근사(종가×거래량)
async function fetchNaverTrdValApprox(codes, basDd) {
  const map = {};
  const one = async (code) => {
    try {
      const t = await getText(`https://fchart.stock.naver.com/sise.nhn?symbol=${code}&timeframe=day&count=8&requestType=0`);
      for (const m of t.matchAll(/data="(\d{8})\|[\d.]+\|[\d.]+\|[\d.]+\|([\d.]+)\|(\d+)"/g)) {
        if (m[1] === basDd) { map[code] = { trdval: num(m[2]) * num(m[3]), close: num(m[2]), approx: true }; return; }
      }
    } catch (e) { /* 개별 종목 누락 허용 */ }
  };
  for (let i = 0; i < codes.length; i += 10) await Promise.all(codes.slice(i, i + 10).map(one));
  return map;
}

// ---------- 6) 시장 심리 지표 (VKOSPI · Fear&Greed · ADR) ----------
// 일별 파생 데이터 캐시: 스크립트 옆 sugup_cache.json (클라우드에선 워크플로가 커밋해 증분 유지)
//   { "YYYYMMDD": { hol:true } | { ksUp,ksDn,kqUp,kqDn(등락종목수), vkospi, bond(KRX채권 총수익지수), pcr(K200옵션 풋/콜 거래대금비) } }
const CACHE_FILE = path.join(__dirname, 'sugup_cache.json');
const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;

async function updateDailyCache(kospiHist) {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (e) {}
  const key = getKrxKey();
  if (!key) return cache;
  // 네이버 지수 캔들로 거래일 교차검증: KRX 응답이 비어도 캔들이 있으면 휴장이 아니라 일시 장애 →
  // hol 마킹하지 않고 건너뛴다(다음 실행 때 재시도). 캔들 목록에 없는 과거 평일만 휴장 확정.
  const candleDates = new Set((kospiHist || []).map(h => h.date));
  const latestCandle = kospiHist && kospiHist.length ? kospiHist[kospiHist.length - 1].date : null;
  // 과거 KRX 일시 장애로 잘못 hol 처리된 날짜 복구
  for (const d of Object.keys(cache)) if (cache[d].hol && candleDates.has(d)) delete cache[d];
  const call = async (ep, dd) => {
    try {
      const r = await fetch(`https://data-dbg.krx.co.kr/svc/apis/${ep}?basDd=${dd}`, { headers: { AUTH_KEY: key } });
      const j = await r.json();
      if (j.respCode) return null;
      return Object.values(j).find(Array.isArray) || [];
    } catch (e) { return null; }
  };
  const upDn = (rows) => { let up = 0, dn = 0; for (const r of rows) { const f = num(r.FLUC_RT); if (f > 0) up++; else if (f < 0) dn++; } return [up, dn]; };

  const sumTv = (rows) => rows.reduce((s, r) => s + (num(r.ACC_TRDVAL) || 0), 0); // 시장 거래대금 합(원)
  let d = new Date(), tradingSeen = 0, pcrDone = false, krxDead = false;
  for (let scanned = 0; tradingSeen < 95 && scanned < 150 && !krxDead; scanned++) {
    const dd = ymd(d);
    const dow = d.getUTCDay();
    d = new Date(d.getTime() - 86400000);
    if (dow === 0 || dow === 6) continue;
    const e = cache[dd] || {};
    if (e.hol) continue;
    if (latestCandle && dd > latestCandle) continue; // 아직 개장 전/미발표 날짜
    // 거래일 판별 겸 코스피 등락종목수·거래대금(과열지표용)
    if (e.ksUp == null || e.tvKs == null) {
      if (candleDates.size && !candleDates.has(dd)) { cache[dd] = { hol: true }; continue; } // 캔들 없음 = 휴장 확정
      const stk = await call('sto/stk_bydd_trd', dd);
      if (stk == null) { krxDead = true; break; } // KRX 접근 불가 → 기존 캐시로 진행
      if (!stk.length) continue; // 캔들은 있는데 KRX 미반영/일시 장애 → 마킹 없이 건너뛰고 다음 실행 때 재시도
      [e.ksUp, e.ksDn] = upDn(stk); e.tvKs = sumTv(stk); e.trading = true;
    }
    tradingSeen++;
    if (e.kqUp == null || e.tvKq == null) { const ksq = await call('sto/ksq_bydd_trd', dd); if (ksq && ksq.length) { [e.kqUp, e.kqDn] = upDn(ksq); e.tvKq = sumTv(ksq); } }
    if (e.tvEtf == null) { const etf = await call('etp/etf_bydd_trd', dd); if (etf && etf.length) e.tvEtf = sumTv(etf); }
    if (tradingSeen <= 55 && e.vkospi == null) { const drv = await call('idx/drvprod_dd_trd', dd); const vk = (drv || []).find(r => r.IDX_NM === '코스피 200 변동성지수'); if (vk) e.vkospi = num(vk.CLSPRC_IDX); }
    if (tradingSeen <= 25 && e.bond == null) { const bd = await call('idx/bon_dd_trd', dd); const kb = (bd || []).find(r => (r.BND_IDX_GRP_NM || '') === 'KRX 채권지수'); if (kb) e.bond = num(kb.TOT_EARNG_IDX); }
    if (!pcrDone && e.pcr == null) { // 풋콜비율은 최신 거래일 것만 사용
      const opt = await call('drv/opt_bydd_trd', dd);
      if (opt && opt.length) {
        let p = 0, c = 0;
        for (const o of opt) {
          const pn = o.PROD_NM || '';
          if (!pn.includes('코스피200') || pn.includes('미니')) continue;
          const v = num(o.ACC_TRDVAL) || 0;
          if (o.RGHT_TP_NM === 'PUT') p += v; else if (o.RGHT_TP_NM === 'CALL') c += v;
        }
        if (c > 0) e.pcr = Math.round(p / c * 1000) / 1000;
      }
    }
    if (e.pcr != null) pcrDone = true;
    cache[dd] = e;
  }
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), 'utf8'); } catch (e) {}
  return cache;
}

async function fetchKospiHistory(count = 200) { // 종가 이력 (F&G 모멘텀·안전자산용)
  try {
    const t = await getText(`https://fchart.stock.naver.com/sise.nhn?symbol=KOSPI&timeframe=day&count=${count}&requestType=0`);
    return [...t.matchAll(/data="(\d{8})\|([\d.]+)\|[\d.]+\|[\d.]+\|([\d.]+)\|\d+"/g)].map(m => ({ date: m[1], close: num(m[3]) }));
  } catch (e) { return []; }
}

// CNN Fear&Greed 방법론을 코스피에 맞춘 자체 산출 (요소별 0~100, 동일가중 평균)
function computeFearGreed(cache, kospiHist) {
  const tds = Object.keys(cache).filter(d => cache[d] && !cache[d].hol && cache[d].trading).sort((a, b) => b.localeCompare(a));
  if (!tds.length) return null;
  const latest = tds[0];
  const clamp = (v) => Math.max(0, Math.min(100, v));
  const comps = [];
  // 1. 주가 모멘텀: 코스피 종가 vs 125일 이동평균 (±8% → 0~100)
  const closes = kospiHist.filter(h => h.date <= latest).map(h => h.close);
  if (closes.length >= 125) {
    const c = closes[closes.length - 1], ma = avg(closes.slice(-125));
    const dev = (c / ma - 1) * 100;
    comps.push({ name: '주가 모멘텀', score: clamp(50 + dev * 50 / 8), detail: `125일선 대비 ${signTxt(dev, 1)}%` });
  }
  // 2. 변동성(역방향): VKOSPI vs 50일 평균 (+40% → 0, -40% → 100)
  const vks = tds.map(d => cache[d].vkospi).filter(v => v != null);
  if (vks.length >= 20) {
    const win = Math.min(50, vks.length);
    const dev = (vks[0] / avg(vks.slice(0, win)) - 1) * 100;
    comps.push({ name: '변동성(VKOSPI)', score: clamp(50 - dev * 50 / 40), detail: `${win}일 평균 대비 ${signTxt(dev, 1)}%` });
  }
  // 3. 시장 폭: 코스피 ADR-20 (70 → 0, 130 → 100)
  const cntDays = tds.filter(d => cache[d].ksUp != null).slice(0, 20);
  if (cntDays.length >= 15) {
    const up = cntDays.reduce((s, d) => s + cache[d].ksUp, 0), dn = cntDays.reduce((s, d) => s + cache[d].ksDn, 0);
    const adr = dn > 0 ? up / dn * 100 : 130;
    comps.push({ name: '시장 폭(ADR-20)', score: clamp((adr - 70) * 100 / 60), detail: `코스피 ADR ${fmt(adr, 1)}` });
  }
  // 4. 상승종목 비율(최근 거래일)
  const l = cache[latest];
  if (l.ksUp != null && l.ksUp + l.ksDn > 0) {
    const ratio = l.ksUp / (l.ksUp + l.ksDn) * 100;
    comps.push({ name: '상승종목 비율(당일)', score: clamp(ratio), detail: `상승 ${l.ksUp} : 하락 ${l.ksDn}` });
  }
  // 5. 풋/콜 거래대금 비율: K200옵션 (1.4 → 0, 0.6 → 100)
  const pcrDay = tds.find(d => cache[d].pcr != null);
  if (pcrDay) comps.push({ name: '풋/콜 비율(K200옵션)', score: clamp((1.4 - cache[pcrDay].pcr) * 100 / 0.8), detail: `P/C ${fmt(cache[pcrDay].pcr, 2)}` });
  // 6. 안전자산 수요: 코스피 20일 수익률 − KRX채권지수 20일 수익률 (±6% → 0~100)
  const bonds = tds.map(d => cache[d].bond).filter(v => v != null);
  if (bonds.length >= 21 && closes.length >= 21) {
    const kRet = (closes[closes.length - 1] / closes[closes.length - 21] - 1) * 100;
    const bRet = (bonds[0] / bonds[20] - 1) * 100;
    const spread = kRet - bRet;
    comps.push({ name: '안전자산 대비(20일)', score: clamp(50 + spread * 50 / 6), detail: `주식-채권 ${signTxt(spread, 1)}%p` });
  }
  if (!comps.length) return null;
  const score = Math.round(avg(comps.map(c => c.score)));
  const label = score <= 25 ? '극단적 공포' : score <= 45 ? '공포' : score < 55 ? '중립' : score < 75 ? '탐욕' : '극단적 탐욕';
  return { score, label, comps, latest, tds };
}

// ---------- SVG 라인차트 ----------
function svgChart(series, { width = 560, height = 190, unitDiv = 10000, unitLabel = '조원', color = '#4f8ef7' } = {}) {
  // series: [{date, v}] 과거→최신 순으로 정렬해 전달
  const pad = { l: 46, r: 14, t: 14, b: 24 };
  const W = width - pad.l - pad.r, H = height - pad.t - pad.b;
  const vals = series.map(s => s.v / unitDiv);
  const mn = Math.min(...vals), mx = Math.max(...vals);
  const rng = (mx - mn) || 1;
  const x = (i) => pad.l + (i / (series.length - 1)) * W;
  const y = (v) => pad.t + H - ((v - mn) / rng) * H;
  const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${pad.l},${pad.t + H} ${pts} ${(pad.l + W).toFixed(1)},${pad.t + H}`;
  // x축 라벨: 처음/중간/끝
  const xi = [0, Math.floor(series.length / 2), series.length - 1];
  const xLabels = xi.map(i => `<text x="${x(i).toFixed(1)}" y="${height - 6}" class="axl" text-anchor="${i === 0 ? 'start' : i === series.length - 1 ? 'end' : 'middle'}">${series[i].date}</text>`).join('');
  const yl = [mn, mn + rng / 2, mx];
  const yLabels = yl.map(v => `<text x="${pad.l - 6}" y="${(y(v) + 3.5).toFixed(1)}" class="axl" text-anchor="end">${fmt(v, 1)}</text>`).join('');
  const yGrid = yl.map(v => `<line x1="${pad.l}" y1="${y(v).toFixed(1)}" x2="${pad.l + W}" y2="${y(v).toFixed(1)}" class="grid"/>`).join('');
  const last = series[series.length - 1];
  return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    ${yGrid}
    <polygon points="${area}" fill="${color}" opacity="0.10"/>
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2"/>
    <circle cx="${x(series.length - 1).toFixed(1)}" cy="${y(last.v / unitDiv).toFixed(1)}" r="3.5" fill="${color}"/>
    ${xLabels}${yLabels}
    <text x="${pad.l}" y="${pad.t - 2}" class="axl">${unitLabel}</text>
  </svg>`;
}

// ---------- 7) 과열지표: (코스피+코스닥+ETF 거래대금) ÷ 투자자예탁금 ----------
// 거래대금은 KRX 오픈API 일별 합산(sugup_cache의 tvKs/tvKq/tvEtf) — 참고 이미지의 '총 거래대금' 스케일과 일치
function buildOverheat(cache, dep, kospiHist) {
  const depList = dep.map(r => ({ date: '20' + r.date.replace(/\./g, ''), v: r.deposit / 10000 })).sort((a, b) => b.date.localeCompare(a.date));
  if (!depList.length) return null;
  const latestDep = depList[0].date;
  const depAsOf = (d) => { for (const r of depList) if (r.date <= d) return r.v; return null; };
  const closeMap = Object.fromEntries(kospiHist.map(h => [h.date, h.close]));
  const tds = Object.keys(cache).filter(d => cache[d].trading && cache[d].tvKs != null && cache[d].tvKq != null).sort((a, b) => b.localeCompare(a));
  const rows = [];
  for (const dd of tds) { // 최신순
    const e = cache[dd];
    const depV = depAsOf(dd);
    if (depV == null) continue;
    const ksTr = e.tvKs / 1e12, kqTr = e.tvKq / 1e12, etfTr = (e.tvEtf || 0) / 1e12; // 조원
    const total = ksTr + kqTr + etfTr;
    const ratio = total / depV;
    rows.push({
      date: dd, close: closeMap[dd] || null, ksTr, kqTr, etfTr, total, dep: depV, ratio,
      ratioKs: ksTr / depV, ratioKq: kqTr / depV,
      prov: dd > latestDep, // 예탁금 최신 공표일 이후 → 잠정(최근 공표 예탁금으로 나눔)
      verdict: ratio >= 1.0 ? '과열' : ratio >= 0.9 ? '주의' : ratio <= 0.6 ? '냉각' : '중립',
    });
  }
  if (!rows.length) return null;
  // 등락률(전일비)
  for (let i = 0; i < rows.length - 1; i++) if (rows[i].close && rows[i + 1].close) rows[i].rate = (rows[i].close / rows[i + 1].close - 1) * 100;
  // 0.90x 이상 이벤트 사후 성과 (10/20/60일 수익률·MDD) — 가용 90영업일 창 안에서
  const asc = [...rows].reverse();
  const events = [];
  asc.forEach((r, i) => {
    if (r.ratio < 0.9 || !r.close) return;
    const ev = { ...r };
    for (const n of [10, 20, 60]) {
      const fwd = asc.slice(i + 1, i + n + 1).map(x => x.close).filter(Boolean);
      if (i + n < asc.length && asc[i + n].close && fwd.length === n) {
        ev['r' + n] = (asc[i + n].close / r.close - 1) * 100;
        ev['mdd' + n] = (Math.min(...fwd) / r.close - 1) * 100;
      } else { ev['r' + n] = null; ev['mdd' + n] = null; }
    }
    events.push(ev);
  });
  events.reverse(); // 최신 먼저
  return { rows, asc, events, latestDep };
}

// 과열지표 차트: 합산 배율(굵은 선) + 코스피/코스닥 배율(얇은 선) + 0.9/1.0 기준선
function svgRatioChart(asc) {
  const W = 1180, H = 260, pad = { l: 46, r: 14, t: 16, b: 26 };
  const IW = W - pad.l - pad.r, IH = H - pad.t - pad.b;
  const vals = asc.map(r => r.ratio);
  const mx = Math.max(1.05, ...vals) * 1.05, mn = Math.max(0, Math.min(...asc.map(r => r.ratioKq)) * 0.85);
  const x = (i) => pad.l + i / (asc.length - 1) * IW;
  const y = (v) => pad.t + IH - (v - mn) / (mx - mn) * IH;
  const line = (get, color, w2, op) => `<polyline points="${asc.map((r, i) => x(i).toFixed(1) + ',' + y(get(r)).toFixed(1)).join(' ')}" fill="none" stroke="${color}" stroke-width="${w2}" opacity="${op}"/>`;
  const thr = (v, color, lab) => v < mx ? `<line x1="${pad.l}" y1="${y(v).toFixed(1)}" x2="${pad.l + IW}" y2="${y(v).toFixed(1)}" stroke="${color}" stroke-width="1" stroke-dasharray="5,4"/><text x="${pad.l + IW - 4}" y="${(y(v) - 4).toFixed(1)}" class="axl" text-anchor="end" fill="${color}">${lab}</text>` : '';
  const dots = asc.map((r, i) => r.ratio >= 1.0 ? `<circle cx="${x(i).toFixed(1)}" cy="${y(r.ratio).toFixed(1)}" r="3.5" fill="#f4516c"/>` : '').join('');
  const xi = [0, Math.floor(asc.length / 2), asc.length - 1];
  const fmtD = (d) => d.slice(2, 4) + '.' + d.slice(4, 6) + '.' + d.slice(6, 8);
  const yls = [mn, (mn + mx) / 2, mx].map(v => `<text x="${pad.l - 6}" y="${(y(v) + 3.5).toFixed(1)}" class="axl" text-anchor="end">${fmt(v, 2)}</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
    ${[mn, (mn + mx) / 2, mx].map(v => `<line x1="${pad.l}" y1="${y(v).toFixed(1)}" x2="${pad.l + IW}" y2="${y(v).toFixed(1)}" class="grid"/>`).join('')}
    ${thr(0.9, '#e2a03f', '주의 0.9x')}${thr(1.0, '#f4516c', '과열 1.0x')}
    ${line(r => r.ratioKs, '#4f8ef7', 1.2, 0.55)}${line(r => r.ratioKq, '#43b58e', 1.2, 0.55)}${line(r => r.ratio, '#f4516c', 2.2, 1)}
    ${dots}${yls}
    ${xi.map(i => `<text x="${x(i).toFixed(1)}" y="${H - 8}" class="axl" text-anchor="${i === 0 ? 'start' : i === asc.length - 1 ? 'end' : 'middle'}">${fmtD(asc[i].date)}</text>`).join('')}
    <g font-size="10" fill="#8492ad"><text x="${pad.l + 4}" y="${pad.t + 10}">— 합산(코스피+코스닥+ETF)/예탁금</text><text x="${pad.l + 190}" y="${pad.t + 10}" fill="#4f8ef7">— 코스피/예탁금</text><text x="${pad.l + 300}" y="${pad.t + 10}" fill="#43b58e">— 코스닥/예탁금</text></g>
  </svg>`;
}

// Fear&Greed 반원 게이지 SVG (0=극단공포 좌측, 100=극단탐욕 우측)
function svgGauge(score, label) {
  const W = 260, H = 150, cx = 130, cy = 130, R = 100, r = 74;
  const arc = (a0, a1, R1, R2, color) => {
    const p = (a, rad) => [cx + rad * Math.cos(Math.PI * (1 - a / 100)), cy - rad * Math.sin(Math.PI * (1 - a / 100))];
    const [x0, y0] = p(a0, R1), [x1, y1] = p(a1, R1), [x2, y2] = p(a1, R2), [x3, y3] = p(a0, R2);
    const lg = (a1 - a0) > 50 ? 1 : 0;
    return `<path d="M${x0.toFixed(1)},${y0.toFixed(1)} A${R1},${R1} 0 ${lg} 1 ${x1.toFixed(1)},${y1.toFixed(1)} L${x2.toFixed(1)},${y2.toFixed(1)} A${R2},${R2} 0 ${lg} 0 ${x3.toFixed(1)},${y3.toFixed(1)} Z" fill="${color}"/>`;
  };
  const zones = [[0, 25, '#2456b8'], [25, 45, '#3d8bfd'], [45, 55, '#5a6478'], [55, 75, '#e2506c'], [75, 100, '#c81e40']];
  const na = Math.PI * (1 - score / 100);
  const nx = cx + (r - 12) * Math.cos(na), ny = cy - (r - 12) * Math.sin(na);
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="max-width:280px;margin:0 auto">
    ${zones.map(z => arc(z[0], z[1], R, r, z[2])).join('')}
    <line x1="${cx}" y1="${cy}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" stroke="#dbe4f5" stroke-width="3.5" stroke-linecap="round"/>
    <circle cx="${cx}" cy="${cy}" r="6" fill="#dbe4f5"/>
    <text x="${cx}" y="${cy - 26}" text-anchor="middle" style="font-size:30px;font-weight:bold" fill="#dbe4f5">${score}</text>
    <text x="18" y="${H - 4}" class="axl">공포 0</text>
    <text x="${W - 18}" y="${H - 4}" class="axl" text-anchor="end">100 탐욕</text>
  </svg>
  <div style="text-align:center;font-size:15px;font-weight:bold;margin-top:2px">${label}</div>`;
}

// ---------- HTML 렌더링 ----------
// [과열지표] 탭 본문
function renderOverheat(oh) {
  if (!oh) return '<div class="card"><div class="ttl">과열지표</div><div class="lockbody">거래대금/예탁금 데이터 수집 실패 — 다음 갱신 때 재시도됩니다.</div></div>';
  const fmtD = (d) => d.slice(4, 6) + '/' + d.slice(6, 8);
  const latest = oh.rows[0];
  const vClass = { '과열': 'v-hot', '주의': 'v-warn', '냉각': 'v-cool', '중립': '' };
  const dailyRows = oh.rows.slice(0, 30).reverse(); // 오래→최신, 최근 30거래일
  const daily = dailyRows.map(r => `
    <tr class="${vClass[r.verdict]}${r.prov ? ' prov' : ''}">
      <td>${fmtD(r.date)}${r.prov ? ' 잠정' : ''}</td>
      <td>${fmt(r.close, 0)}</td>
      <td class="${signCls(r.rate)}">${r.rate != null ? signTxt(r.rate, 1) + '%' : '-'}</td>
      <td>${fmt(r.ksTr, 1)}</td><td>${fmt(r.kqTr, 1)}</td><td>${fmt(r.etfTr, 1)}</td><td><b>${fmt(r.total, 1)}</b></td>
      <td>${fmt(r.dep, 1)}</td>
      <td><b>${fmt(r.ratio, 2)}x</b></td>
      <td>${r.verdict}</td>
    </tr>`).join('');
  const evCell = (v) => v == null ? '<td>-</td>' : `<td class="${signCls(v)}">${signTxt(v, 1)}%</td>`;
  const events = oh.events.map(r => `
    <tr>
      <td>${r.date.slice(0, 4)}-${r.date.slice(4, 6)}-${r.date.slice(6, 8)}</td>
      <td><b>${fmt(r.ratio, 2)}x</b></td><td>${fmt(r.total, 1)}조</td><td>${fmt(r.dep, 1)}조</td><td>${fmt(r.close, 0)}</td>
      ${evCell(r.r10)}${evCell(r.mdd10)}${evCell(r.r20)}${evCell(r.mdd20)}${evCell(r.r60)}${evCell(r.mdd60)}
    </tr>`).join('');
  return `
<div class="grid" style="grid-template-columns:1fr">
  <div class="card">
    <div class="ttl">하루 거래대금이 예탁금 대비 얼마나 컸나 (거래대금/예탁금 배율, 최근 ${oh.asc.length}영업일)</div>
    <div class="chstat">최신 ${fmtD(latest.date)}${latest.prov ? ' 잠정' : ''}: <b>${fmt(latest.ratio, 2)}x</b> (거래대금 ${fmt(latest.total, 1)}조 ÷ 예탁금 ${fmt(latest.dep, 1)}조) — ${latest.verdict}</div>
    ${svgRatioChart(oh.asc)}
    <div class="mini">하루 거래대금은 그날 시장이 쓴 연료, 예탁금은 남은 연료통. 배율이 0.9x(주의)~1.0x(과열)에 가까워지면 단기 과열 점검 신호로 해석, 0.6x 이하는 냉각. 거래대금은 코스피+코스닥+ETF 합산(KRX 확정치), 예탁금 공표(금투협)가 2~3영업일 늦어 공표 이후 날짜는 최근 공표 예탁금으로 나눈 잠정치.</div>
  </div>
  <div class="card">
    <div class="ttl">유동성 과열 데일리 표 (최근 30거래일, 단위 조원)</div>
    <table class="rank">
      <tr><th>일자</th><th>KOSPI</th><th>당일</th><th>코스피</th><th>코스닥</th><th>ETF</th><th>합계</th><th>예탁금</th><th>배율</th><th>판정</th></tr>
      ${daily}
    </table>
  </div>
  <div class="card">
    <div class="ttl">배율 0.90x 이상 발생일 사후 성과 (최근 ${oh.asc.length}영업일 창)</div>
    ${oh.events.length ? `<table class="rank">
      <tr><th>일자</th><th>배율</th><th>거래대금</th><th>예탁금</th><th>KOSPI</th><th>10D</th><th>10D MDD</th><th>20D</th><th>20D MDD</th><th>60D</th><th>60D MDD</th></tr>
      ${events}
    </table>` : '<div class="lockbody">최근 창 안에 0.90x 이상 발생일이 없습니다.</div>'}
    <div class="mini">수익률은 KOSPI 종가 기준 사후 N영업일, MDD는 해당 구간 내 최저점까지 낙폭. '-'는 아직 경과일 미충족. 데이터 창이 90영업일이라 과거 사례는 제한적.</div>
  </div>
</div>`;
}

function render(data) {
  const { rt, krx, dep, invK, invQ, ranks, trdvalMap, cache, fg, oh, now } = data;
  const kospi = rt.KOSPI, kosdaq = rt.KOSDAQ;
  const stateTxt = kospi.state === 'OPEN' ? '장중' : '장마감';
  const invKr = invK[0], invQr = invQ[0];

  // 예탁금/신용 차트 (과거→최신)
  const depAsc = [...dep].reverse();
  const depChart = svgChart(depAsc.map(r => ({ date: r.date, v: r.deposit })), { color: '#4f8ef7' });
  const crdChart = svgChart(depAsc.map(r => ({ date: r.date, v: r.credit })), { color: '#e2a03f' });
  const d0 = dep[0];

  // 주체별 표 행 (사용자 요청 6주체 + 참고)
  const invRow = (label, k, q, note) => {
    const kv = k == null ? null : k, qv = q == null ? null : q;
    return `<tr><td class="lbl">${label}${note ? `<span class="note">${note}</span>` : ''}</td>
      <td class="${signCls(kv)}">${kv == null ? '-' : signTxt(kv)}</td>
      <td class="${signCls(qv)}">${qv == null ? '-' : signTxt(qv)}</td></tr>`;
  };

  // 순매매 상위: 시장 합산 후 금액순 top5 (기준일: 네이버 순위표 최신 확정일)
  const rankDate = ranks.f01b.date || ranks.i01b.date || '-';
  const mergeTop = (a, b) => [...a.rows, ...b.rows].sort((x, y) => y.amtM - x.amtM).slice(0, 5);
  const frgBuy = mergeTop(ranks.f01b, ranks.f02b), frgSell = mergeTop(ranks.f01s, ranks.f02s);
  const insBuy = mergeTop(ranks.i01b, ranks.i02b), insSell = mergeTop(ranks.i01s, ranks.i02s);

  const rankTable = (rows, dir) => `<table class="rank">
    <tr><th>종목</th><th>금액(억원)</th><th>수량(천주)</th></tr>
    ${rows.map(r => `<tr><td>${esc(r.name)}</td><td class="${dir}">${dir === 'up' ? '+' : '-'}${fmt(r.amtM / 100, 0)}</td><td>${fmt(r.qtyK)}</td></tr>`).join('')}
  </table>`;

  // 수급강도: 순매수금액 ÷ 기준일 거래대금 (외국인+기관 합산, 동일종목 합산)
  //   ※ 순위표의 '당일거래량' 컬럼은 조회 시점(오늘 장중) 거래량이라 분모로 부적합 → KRX 확정 거래대금 사용
  const strength = (buyLists, sellLists) => {
    const agg = (lists) => {
      const m = new Map();
      for (const r of lists.map(l => l.rows).flat()) {
        const cur = m.get(r.code) || { code: r.code, name: r.name, amtM: 0 };
        cur.amtM += r.amtM;
        m.set(r.code, cur);
      }
      return [...m.values()]
        .filter(r => r.amtM >= 5000) // 순매수 50억원 미만 초소형 노이즈 제외
        .map(r => { const tv = trdvalMap[r.code]; return { ...r, trdval: tv ? tv.trdval : null, approx: !!(tv && tv.approx) }; })
        .filter(r => r.trdval > 0)
        .map(r => ({ ...r, ratio: r.amtM * 1000000 / r.trdval * 100 }))
        .sort((a, b) => b.ratio - a.ratio).slice(0, 5);
    };
    return { top: agg(buyLists), bottom: agg(sellLists) };
  };
  const st = strength([ranks.f01b, ranks.f02b, ranks.i01b, ranks.i02b], [ranks.f01s, ranks.f02s, ranks.i01s, ranks.i02s]);
  const stTable = (rows, dir) => `<table class="rank">
    <tr><th>종목</th><th>거래대금 대비</th><th>금액(억원)</th></tr>
    ${rows.map(r => `<tr><td>${esc(r.name)}</td><td class="${dir}">${dir === 'up' ? '+' : '-'}${fmt(r.ratio, 1)}%</td><td>${fmt(r.amtM / 100)}</td></tr>`).join('')}
  </table>`;

  const idxCard = (name, o, official) => `
    <div class="card idx">
      <div class="ttl">${name} <span class="tag">${stateTxt}</span></div>
      <div class="big ${signCls(o.chg)}">${fmt(o.now, 2)}</div>
      <div class="sub ${signCls(o.chg)}">${signTxt(o.chg, 2)} (${signTxt(o.rate, 2)}%)</div>
      <div class="mini">고가 ${fmt(o.high, 2)} · 저가 ${fmt(o.low, 2)} · 거래대금 ${fmt(o.amountM / 1000000, 1)}조원</div>
      ${official ? `<div class="mini dim">전영업일 확정(KRX ${official.BAS_DD}): ${fmt(num(official.CLSPRC_IDX), 2)} (${signTxt(num(official.FLUC_RT), 2)}%)</div>` : ''}
    </div>`;

  const lockedCard = (title, body) => `
    <div class="card locked">
      <div class="ttl">${title} <span class="tag lock">잠금</span></div>
      <div class="lockbody">${body}</div>
    </div>`;

  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>수급 대시보드 ${now.slice(0, 10)}</title>
<style>
  :root { --bg:#0f1420; --card:#171e2e; --line:#232c42; --tx:#dbe4f5; --dim:#8492ad;
          --up:#f4516c; --dn:#3d8bfd; --fl:#8492ad; --acc:#4f8ef7; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bg); color:var(--tx); font-family:'Malgun Gothic','Segoe UI',sans-serif; padding:22px; }
  h1 { font-size:21px; margin-bottom:4px; }
  .meta { color:var(--dim); font-size:12px; margin-bottom:18px; }
  .grid { display:grid; gap:14px; margin-bottom:14px; }
  .g4 { grid-template-columns:repeat(4,1fr); }
  .g3 { grid-template-columns:repeat(3,1fr); }
  .g2 { grid-template-columns:repeat(2,1fr); }
  @media (max-width:1100px){ .g4{grid-template-columns:repeat(2,1fr);} .g3{grid-template-columns:1fr;} .g2{grid-template-columns:1fr;} }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; }
  .ttl { font-size:13px; color:var(--dim); font-weight:bold; margin-bottom:10px; }
  .tag { background:#233150; color:#7fa8ef; font-size:10px; padding:2px 7px; border-radius:8px; margin-left:6px; vertical-align:1px; }
  .tag.lock { background:#3a2a35; color:#d99; }
  .big { font-size:28px; font-weight:bold; }
  .sub { font-size:14px; margin-top:2px; }
  .mini { font-size:11px; color:var(--dim); margin-top:8px; line-height:1.6; }
  .mini.dim { opacity:.8; }
  .up { color:var(--up); } .dn { color:var(--dn); } .fl { color:var(--fl); }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { color:var(--dim); font-weight:normal; font-size:11px; text-align:right; padding:4px 6px; border-bottom:1px solid var(--line); }
  th:first-child { text-align:left; }
  td { padding:6px; text-align:right; border-bottom:1px solid var(--line); }
  td:first-child { text-align:left; }
  tr:last-child td { border-bottom:none; }
  td.lbl { color:var(--tx); }
  .note { color:var(--dim); font-size:10px; margin-left:5px; }
  .rank td:first-child { max-width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  svg { width:100%; height:auto; display:block; }
  .axl { font-size:10px; fill:var(--dim); font-family:'Malgun Gothic',sans-serif; }
  .grid line, line.grid { stroke:var(--line); stroke-width:1; }
  .chstat { font-size:12px; color:var(--dim); margin-bottom:8px; }
  .chstat b { color:var(--tx); font-size:15px; }
  .lockbody { font-size:12px; color:var(--dim); line-height:1.8; }
  .sec { font-size:14px; font-weight:bold; margin:22px 0 10px; color:#aebfdd; }
  .src { color:var(--dim); font-size:11px; line-height:1.8; margin-top:20px; border-top:1px solid var(--line); padding-top:12px; }
  .tabbar { display:flex; gap:8px; margin-bottom:16px; }
  .tabbtn { background:var(--card); border:1px solid var(--line); color:var(--dim); padding:8px 18px; border-radius:9px; font-size:13px; font-weight:bold; cursor:pointer; font-family:inherit; }
  .tabbtn.active { background:#233150; color:#cfe0ff; border-color:#3a4d78; }
  .v-hot td { background:rgba(244,81,108,0.12); }
  .v-warn td { background:rgba(226,160,63,0.10); }
  .v-cool td { background:rgba(61,139,253,0.08); }
  .prov td { border-top:1px solid #4f8ef7; border-bottom:1px solid #4f8ef7; }
</style></head><body>
<h1>국내 증시 수급 대시보드</h1>
<div class="meta">갱신: ${now} · 지수 ${stateTxt} 기준 · 투자자별 순매수 기준일 ${invKr ? invKr.date : '-'} · 예탁금/신용 최신일 ${d0 ? d0.date : '-'}</div>
<div class="tabbar">
  <button class="tabbtn active" id="btn-main" onclick="showTab('main')">수급 현황</button>
  <button class="tabbtn" id="btn-overheat" onclick="showTab('overheat')">과열지표</button>
</div>
<div id="tab-main">

<div class="grid g4">
  ${idxCard('코스피', kospi, krx && krx.kospi)}
  ${idxCard('코스닥', kosdaq, krx && krx.kosdaq)}
  <div class="card">
    <div class="ttl">투자자예탁금 <span class="tag">${d0 ? d0.date : '-'}</span></div>
    <div class="big">${d0 ? fmt(d0.deposit / 10000, 1) : '-'}<span style="font-size:15px"> 조원</span></div>
    <div class="sub ${d0 ? signCls(d0.depositChg) : 'fl'}">${d0 ? signTxt(d0.depositChg / 10000, 2) + ' 조원 (전일비)' : ''}</div>
    <div class="mini">90영업일 최고 ${fmt(Math.max(...dep.map(r => r.deposit)) / 10000, 1)}조 · 최저 ${fmt(Math.min(...dep.map(r => r.deposit)) / 10000, 1)}조</div>
  </div>
  <div class="card">
    <div class="ttl">신용거래융자 잔고 <span class="tag">${d0 ? d0.date : '-'}</span></div>
    <div class="big">${d0 ? fmt(d0.credit / 10000, 1) : '-'}<span style="font-size:15px"> 조원</span></div>
    <div class="sub ${d0 ? signCls(d0.creditChg) : 'fl'}">${d0 ? signTxt(d0.creditChg / 10000, 2) + ' 조원 (전일비)' : ''}</div>
    <div class="mini">90영업일 최고 ${fmt(Math.max(...dep.map(r => r.credit)) / 10000, 1)}조 · 최저 ${fmt(Math.min(...dep.map(r => r.credit)) / 10000, 1)}조</div>
  </div>
</div>

${(() => {
  if (!fg) return '';
  const tds = fg.tds;
  const fmtD = (d) => d.slice(2, 4) + '.' + d.slice(4, 6) + '.' + d.slice(6, 8);
  // VKOSPI 카드
  const vkDays = tds.filter(d => cache[d].vkospi != null);
  const vk0 = vkDays.length ? cache[vkDays[0]].vkospi : null;
  const vk1 = vkDays.length > 1 ? cache[vkDays[1]].vkospi : null;
  const vkChg = vk0 != null && vk1 != null ? vk0 - vk1 : null;
  const vkChart = vkDays.length >= 10 ? svgChart(
    vkDays.slice().reverse().map(d => ({ date: fmtD(d), v: cache[d].vkospi })),
    { width: 560, height: 150, unitDiv: 1, unitLabel: 'pt', color: '#c86ee0' }) : '';
  // ADR 카드 (양 시장 20일)
  const adrOf = (upK, dnK) => {
    const ds = tds.filter(d => cache[d][upK] != null).slice(0, 20);
    if (ds.length < 15) return null;
    const up = ds.reduce((s, d) => s + cache[d][upK], 0), dn = ds.reduce((s, d) => s + cache[d][dnK], 0);
    return dn > 0 ? up / dn * 100 : null;
  };
  const adrKs = adrOf('ksUp', 'ksDn'), adrKq = adrOf('kqUp', 'kqDn');
  const adrTag = (v) => v == null ? '' : v >= 120 ? '과열권' : v <= 75 ? '침체권(바닥 신호)' : '중립권';
  const lt = cache[fg.latest];
  return `
<div class="sec">시장 심리 — 기준일 ${fmtD(fg.latest)} (KRX 확정치 기반)</div>
<div class="grid g3">
  <div class="card">
    <div class="ttl">코스피 Fear &amp; Greed <span class="tag">자체산출</span></div>
    ${svgGauge(fg.score, fg.label)}
    <table style="margin-top:10px;font-size:11px">
      ${fg.comps.map(c => `<tr><td class="lbl" style="font-size:11px">${c.name}</td><td style="font-size:11px">${c.detail}</td><td class="${c.score >= 55 ? 'up' : c.score <= 45 ? 'dn' : 'fl'}" style="font-size:11px">${Math.round(c.score)}</td></tr>`).join('')}
    </table>
    <div class="mini">CNN Fear&amp;Greed 방법론을 코스피에 맞춰 ${fg.comps.length}개 요소 동일가중 산출 (0 공포 ~ 100 탐욕)</div>
  </div>
  <div class="card">
    <div class="ttl">VKOSPI (코스피200 변동성지수)</div>
    <div class="big ${vkChg > 0 ? 'up' : vkChg < 0 ? 'dn' : 'fl'}">${vk0 != null ? fmt(vk0, 2) : '-'}</div>
    <div class="sub ${vkChg > 0 ? 'up' : vkChg < 0 ? 'dn' : 'fl'}">${vkChg != null ? signTxt(vkChg, 2) + ' (' + signTxt(vkChg / vk1 * 100, 1) + '%)' : ''}</div>
    <div class="mini" style="margin-bottom:8px">${vkDays.length}영업일 최고 ${fmt(Math.max(...vkDays.map(d => cache[d].vkospi)), 1)} · 최저 ${fmt(Math.min(...vkDays.map(d => cache[d].vkospi)), 1)} — 높을수록 공포(통상 20 미만 안정, 30 이상 불안)</div>
    ${vkChart}
  </div>
  <div class="card">
    <div class="ttl">ADR 등락비율 (20일)</div>
    <div class="big">${adrKs != null ? fmt(adrKs, 1) : '-'}<span style="font-size:14px"> 코스피</span></div>
    <div class="sub fl">${adrTag(adrKs)}</div>
    <div class="big" style="font-size:22px;margin-top:10px">${adrKq != null ? fmt(adrKq, 1) : '-'}<span style="font-size:13px"> 코스닥</span></div>
    <div class="sub fl">${adrTag(adrKq)}</div>
    <div class="mini">ADR = 20일 상승종목수 합 ÷ 하락종목수 합 × 100. 75 이하 침체(반등 임박), 120 이상 과열 신호로 해석.<br>
    최근 거래일: 코스피 상승 ${lt.ksUp ?? '-'} / 하락 ${lt.ksDn ?? '-'} · 코스닥 상승 ${lt.kqUp ?? '-'} / 하락 ${lt.kqDn ?? '-'}</div>
  </div>
</div>`;
})()}

<div class="sec">당일 투자자별 순매수 (억원) — 기준일 ${invKr ? invKr.date : '-'}</div>
<div class="grid g2">
  <div class="card">
    <div class="ttl">주요 주체</div>
    <table>
      <tr><th>주체</th><th>코스피</th><th>코스닥</th></tr>
      ${invRow('개인', invKr && invKr.개인, invQr && invQr.개인)}
      ${invRow('외국인', invKr && invKr.외국인, invQr && invQr.외국인)}
      ${invRow('연기금등', invKr && invKr.연기금등, invQr && invQr.연기금등)}
      ${invRow('투신(사모 포함)', invKr && invKr.투신사모, invQr && invQr.투신사모, '네이버 분류상 사모+투신 합산')}
      ${invRow('금융투자', invKr && invKr.금융투자, invQr && invQr.금융투자)}
      ${invRow('기관계', invKr && invKr.기관계, invQr && invQr.기관계)}
    </table>
  </div>
  <div class="card">
    <div class="ttl">기타 주체 (참고)</div>
    <table>
      <tr><th>주체</th><th>코스피</th><th>코스닥</th></tr>
      ${invRow('보험', invKr && invKr.보험, invQr && invQr.보험)}
      ${invRow('은행', invKr && invKr.은행, invQr && invQr.은행)}
      ${invRow('기타금융', invKr && invKr.기타금융, invQr && invQr.기타금융)}
      ${invRow('기타법인', invKr && invKr.기타법인, invQr && invQr.기타법인)}
    </table>
    <div class="mini">사모펀드 단독 수치는 KRX 정보데이터시스템 로그인 전용으로 전환되어 현재 무료 소스가 없습니다. 네이버(KOSCOM) 분류는 투신(사모) 합산 기준.</div>
  </div>
</div>

${(() => {
  const mk = (rows, label) => {
    if (!rows || rows.length < 10) return `<div class="card"><div class="ttl">${label}</div><div class="lockbody">데이터 부족</div></div>`;
    const asc = rows.slice().reverse().map(r => ({ date: r.date, v: r.외국인 }));
    const total = asc.reduce((s, r) => s + r.v, 0);
    const buyDays = asc.filter(r => r.v > 0).length;
    const l = asc[asc.length - 1];
    return `<div class="card">
      <div class="ttl">${label} <span class="tag">${rows[rows.length - 1].date} ~ ${rows[0].date}</span></div>
      <div class="chstat">최근일(${l.date}) <b class="${signCls(l.v)}">${signTxt(l.v)}억</b> · ${asc.length}일 누적 <b class="${signCls(total)}">${signTxt(total / 10000, 2)}조</b> · 순매수 ${buyDays}일 / 순매도 ${asc.length - buyDays}일</div>
      ${svgBarChart(asc)}
    </div>`;
  };
  return `
<div class="sec">외국인 일별 순매수 추이 — 최근 ${invK.length}영업일 (막대: 일별 순매수 억원, 노란선: 누적)</div>
<div class="grid g2">
  ${mk(invK, '코스피 · 외국인 순매수')}
  ${mk(invQ, '코스닥 · 외국인 순매수')}
</div>`;
})()}

<div class="sec">시장 유동성 — 최근 90영업일</div>
<div class="grid g3">
  <div class="card">
    <div class="ttl">투자자예탁금 추이</div>
    <div class="chstat"><b>${d0 ? fmt(d0.deposit / 10000, 1) : '-'}조원</b> (${d0 ? signTxt(d0.depositChg, 0) : '-'}억)</div>
    ${depChart}
  </div>
  <div class="card">
    <div class="ttl">신용거래융자 잔고 추이</div>
    <div class="chstat"><b>${d0 ? fmt(d0.credit / 10000, 1) : '-'}조원</b> (${d0 ? signTxt(d0.creditChg, 0) : '-'}억)</div>
    ${crdChart}
  </div>
  ${lockedCard('전일 반대매매 / 예탁금 대비 비율', `
    금융투자협회(FreeSIS) 반대매매 통계는 사이트 리뉴얼로 무인증 API가 차단되어 현재 자동 수집이 불가합니다.<br>
    · 수동 확인: <a href="https://freesis.kofia.or.kr/stat/FreeSIS.do?parentDivId=MSIS10000000000000&serviceId=STATSCU0100000060" style="color:#7fa8ef">FreeSIS &gt; 주식 &gt; 증시자금추이</a><br>
    · 연동 재개 조건: FreeSIS 신규 API 경로 확보 시 이 카드에 자동 표시되도록 코드가 준비되어 있습니다.`)}
</div>

<div class="sec">주체별 순매매 상위 top5 — 기준일 ${rankDate} (코스피+코스닥 통합, 금액 기준)</div>
<div class="grid g2">
  <div class="card"><div class="ttl">외국인 순매수 top5</div>${rankTable(frgBuy, 'up')}</div>
  <div class="card"><div class="ttl">외국인 순매도 top5</div>${rankTable(frgSell, 'dn')}</div>
  <div class="card"><div class="ttl">기관 순매수 top5</div>${rankTable(insBuy, 'up')}</div>
  <div class="card"><div class="ttl">기관 순매도 top5</div>${rankTable(insSell, 'dn')}</div>
</div>
<div class="grid g2">
  ${lockedCard('사모펀드 순매수/순매도 top5', `
    KRX 정보데이터시스템(data.krx.co.kr)이 로그인제(KRX Data Marketplace)로 전환되어 주체별 상세 상위종목 무료 조회가 막혔습니다.<br>
    해제 방법 (둘 중 하나):<br>
    · KRX Data Marketplace 계정 생성 후 알려주시면 로그인 연동<br>
    · 키움 OpenAPI 포털(openapi.kiwoom.com)에 현재 공인IP 재등록 → 키움 ka10058(투자자별일별매매종목)로 연동`)}
  ${lockedCard('연기금 순매수/순매도 top5', `
    사모펀드와 동일한 잠금입니다. 키움 REST의 ka10058 TR이 연기금·사모 등 주체별 일별 매매 상위종목을 제공하므로,<br>
    키움 IP 재등록(현재 8050 오류 = 유동IP 변경으로 포털 등록 IP 불일치)만 되면 이 두 섹션과 3주체 수급강도까지 자동 활성화되도록 확장 예정입니다.`)}
</div>

<div class="sec">수급 강도 top5 — 기준일 ${rankDate} (외국인+기관 순매수금액 ÷ 해당일 거래대금${[...st.top, ...st.bottom].some(r => r.approx) ? ', 거래대금은 종가×거래량 근사(네이버)' : ', KRX 확정치'})</div>
<div class="grid g2">
  <div class="card"><div class="ttl">매수 강도 상위 <span class="tag">그날 거래대금의 몇 %를 순매수했나</span></div>${stTable(st.top, 'up')}</div>
  <div class="card"><div class="ttl">매도 강도 상위</div>${stTable(st.bottom, 'dn')}</div>
</div>
<div class="mini" style="margin-top:-6px">※ 요청하신 외국인·사모·연기금 3주체 기준 수급강도는 사모/연기금 상위종목 데이터가 잠금 상태라, 현재는 외국인+기관 합산으로 산출합니다. KRX 로그인 또는 키움 단말기 해제 시 3주체 기준으로 전환됩니다.</div>

</div><!-- /tab-main -->
<div id="tab-overheat" style="display:none">
${renderOverheat(oh)}
</div>
<script>
function showTab(id) {
  for (const t of ['main', 'overheat']) {
    document.getElementById('tab-' + t).style.display = t === id ? '' : 'none';
    document.getElementById('btn-' + t).className = 'tabbtn' + (t === id ? ' active' : '');
  }
}
</script>
<div class="src">
  소스: 지수 네이버 실시간(KOSCOM) + KRX 오픈API 확정치 · 예탁금/신용잔고 네이버 증시자금동향(금융투자협회 집계) · 투자자별 순매수 네이버 투자자별매매동향(KOSCOM) · 순매매 상위 네이버 외국인/기관 순매매 상위 · 과열지표 거래대금 네이버 일별시세<br>
  단위: 순매수 억원 · 예탁금/신용/거래대금 조원 · 상위종목 금액 억원, 수량 천주 · 생성 스크립트: claude_work\\sugup_agent\\sugup_dashboard.js
</div>
</body></html>`;
}

// ---------- 메인 ----------
(async () => {
  const t0 = Date.now();
  console.log('[1/8] 지수(실시간/확정) 수집...');
  const [rt, krx] = await Promise.all([fetchRealtimeIndex(), fetchKrxOfficialIndex()]);
  console.log('[2/8] 예탁금/신용잔고 90영업일 수집...');
  const dep = await fetchDepositCredit(90);
  console.log(`      ${dep.length}일 (${dep[dep.length - 1]?.date} ~ ${dep[0]?.date})`);
  console.log('[3/8] 투자자별 순매수 수집 (90영업일)...');
  const [invK, invQ] = await Promise.all([fetchInvestorTrend('01', 90), fetchInvestorTrend('02', 90)]);
  console.log(`      코스피 ${invK.length}일 · 코스닥 ${invQ.length}일`);
  console.log('[4/8] 외국인/기관 순매매 상위 수집...');
  const [f01b, f01s, f02b, f02s, i01b, i01s, i02b, i02s] = await Promise.all([
    fetchDealRank('01', '9000', 'buy'), fetchDealRank('01', '9000', 'sell'),
    fetchDealRank('02', '9000', 'buy'), fetchDealRank('02', '9000', 'sell'),
    fetchDealRank('01', '1000', 'buy'), fetchDealRank('01', '1000', 'sell'),
    fetchDealRank('02', '1000', 'buy'), fetchDealRank('02', '1000', 'sell'),
  ]);
  const rankDateRaw = f01b.date || i01b.date; // '26.07.13' → '20260713'
  const basDd = rankDateRaw ? '20' + rankDateRaw.replace(/\./g, '') : null;
  console.log(`[5/8] KRX 종목별 거래대금 수집 (기준일 ${basDd})...`);
  const trdvalMap = basDd ? await fetchKrxTradeValueMap(basDd) : {};
  console.log(`      KRX ${Object.keys(trdvalMap).length}종목`);
  // KRX가 막힌 환경(GitHub Actions 등 해외IP)이면 네이버 일별시세로 근사 폴백
  const allCodes = [...new Set([f01b, f01s, f02b, f02s, i01b, i01s, i02b, i02s].flatMap(l => l.rows.map(r => r.code)))];
  const missing = allCodes.filter(c => !trdvalMap[c]);
  if (basDd && missing.length) {
    const approx = await fetchNaverTrdValApprox(missing, basDd);
    Object.assign(trdvalMap, approx);
    console.log(`      네이버 근사 폴백 ${Object.keys(approx).length}/${missing.length}종목`);
  }
  console.log('[6/8] 시장 심리 지표 (VKOSPI·F&G·ADR) 캐시 갱신...');
  const kospiHist = await fetchKospiHistory(); // 거래일 교차검증용으로 캐시 갱신보다 먼저
  const cache = await updateDailyCache(kospiHist);
  const fg = computeFearGreed(cache, kospiHist);
  console.log(`      거래일 캐시 ${Object.keys(cache).filter(d => cache[d].trading).length}일, F&G ${fg ? fg.score + ' (' + fg.label + ', 요소 ' + fg.comps.length + '개)' : '산출 불가'}`);
  console.log('[7/8] 과열지표 조립 (거래대금/예탁금)...');
  const oh = buildOverheat(cache, dep, kospiHist);
  console.log(`      ${oh ? oh.rows.length + '일, 최신 ' + oh.rows[0].date + ' ' + oh.rows[0].ratio.toFixed(2) + 'x (' + oh.rows[0].verdict + (oh.rows[0].prov ? ', 잠정' : '') + ')' : '조립 실패'}`);
  console.log('[8/8] HTML 생성...');
  const now = new Date(Date.now() + 9 * 3600000).toISOString().replace('T', ' ').slice(0, 16) + ' KST';
  const html = render({ rt, krx, dep, invK, invQ, ranks: { f01b, f01s, f02b, f02s, i01b, i01s, i02b, i02s }, trdvalMap, cache, fg, oh, now });
  let out;
  if (OUTFILE) { // 클라우드(GitHub Actions) 모드: 단일 파일만 출력
    out = OUTFILE;
    fs.writeFileSync(out, html, 'utf8');
  } else {
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    out = path.join(OUT_DIR, `수급대시보드_${now.slice(0, 10)}.html`);
    fs.writeFileSync(out, html, 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, '수급대시보드_최신.html'), html, 'utf8'); // 배치파일이 여는 고정 파일명
  }
  console.log(`완료 (${((Date.now() - t0) / 1000).toFixed(1)}s): ${out}`);
  console.log('OUTFILE=' + out);
  if (process.argv.includes('--open')) {
    require('child_process').spawn('cmd', ['/c', 'start', '', path.join(OUT_DIR, '수급대시보드_최신.html')], { detached: true, stdio: 'ignore' }).unref();
  }
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
