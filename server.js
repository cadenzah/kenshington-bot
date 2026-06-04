import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync } from "fs";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

puppeteer.use(StealthPlugin());

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// ============================================================
// 세션 설정 — .env 파일에서 로드, index.html 세션 설정에서도 변경 가능
// ============================================================
const { MEMB_NO, KHRF, MEMB_ID, MEMB_PW, PORT = "3000" } = process.env;
if (!MEMB_NO) {
  console.error("오류: .env 파일에 MEMB_NO를 설정하세요 (.env.example 참고)");
  process.exit(1);
}

const session = {
  memb_no: MEMB_NO,
  khrf: KHRF ?? "",
  memb_id: MEMB_ID ?? "",
  memb_pw: MEMB_PW ?? "",
};

const BASE_URL = "https://www.kensington.co.kr";
const SSO_URL = "https://oneclick.elandretail.com/member/loginIntegrated?noHeader=Y&siteCode=80&returnUrl=https%3A%2F%2Fwww.kensington.co.kr%2Fproc%2Flogin_result";
const NO_ROOM = ["객실이 없습니다", "조회된 객실이 없", "예약 가능한 객실이 없"];

// ============================================================
// Kensington API
// ============================================================
function makeClient() {
  return axios.create({
    baseURL: BASE_URL,
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
      "Referer": `${BASE_URL}/reservation/quick_member`,
      "X-Requested-With": "XMLHttpRequest",
      "Accept-Language": "ko-KR,ko;q=0.9",
      ...(session.khrf && { "Cookie": `khrf=${session.khrf}` }),
    },
  });
}

function extractKhrf(response) {
  const setCookie = response.headers["set-cookie"] ?? [];
  for (const cookie of setCookie) {
    const match = cookie.match(/^khrf=([^;]+)/);
    if (match) return match[1];
  }
  return null;
}

// /member/login 302 응답에서 게스트 khrf 발급
async function fetchFreshKhrf() {
  try {
    const r = await axios.get(`${BASE_URL}/member/login`, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36" },
      maxRedirects: 0,
      validateStatus: () => true,
    });
    return extractKhrf(r);
  } catch (e) {
    if (e.response) return extractKhrf(e.response);
    return null;
  }
}

// Puppeteer로 실제 로그인해서 인증된 khrf 획득
async function loginWithBrowser() {
  if (!session.memb_id || !session.memb_pw) return null;
  console.log("브라우저 자동 로그인 시도 중...");

  let browser;
  try {
    // 시스템 Chrome 사용 시 reCAPTCHA 통과율이 높음
    const chromePath = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    ].find(existsSync);

    browser = await puppeteer.launch({
      headless: false,
      executablePath: chromePath,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
      ],
    });
    const page = await browser.newPage();

    await page.goto(SSO_URL, { waitUntil: "networkidle2", timeout: 20000 });
    await page.waitForSelector("#webId", { timeout: 15000 });

    // reCAPTCHA v3 토큰이 생성될 때까지 대기
    await page.waitForFunction(
      () => typeof window.grecaptcharesponse === "string" && window.grecaptcharesponse.length > 0,
      { timeout: 15000, polling: 300 }
    ).catch(() => console.log("reCAPTCHA 토큰 대기 타임아웃 — 그대로 진행"));

    await page.type("#webId", session.memb_id, { delay: 60 });
    await page.type("#webPwd", session.memb_pw, { delay: 60 });
    await new Promise((r) => setTimeout(r, 500));
    await page.click(".login_btn");

    // 로그인 실패(에러 메시지) 또는 리다이렉트 중 먼저 발생하는 쪽 감지
    const outcome = await Promise.race([
      page.waitForFunction(
        () => window.location.hostname.includes("kensington.co.kr"),
        { timeout: 30000, polling: 500 }
      ).then(() => "redirected"),
      page.waitForFunction(
        () => { const el = document.getElementById("errorMsg"); return el && el.style.display !== "none"; },
        { timeout: 30000, polling: 500 }
      ).then(() => "error"),
    ]).catch(() => "timeout");

    if (outcome !== "redirected") {
      const msg = outcome === "error"
        ? await page.$eval("#errorMsg", (el) => el.innerText).catch(() => "알 수 없는 에러")
        : "타임아웃 — reCAPTCHA 차단 가능성 있음";
      console.error("자동 로그인 실패:", msg);
      await page.screenshot({ path: "/tmp/kenshington-login-fail.png" });
      console.log("스크린샷 저장: /tmp/kenshington-login-fail.png");
      return null;
    }

    // login_result 처리 완료 대기
    await page.waitForFunction(
      () => !window.location.pathname.includes("login_result"),
      { timeout: 15000, polling: 500 }
    ).catch(() => {});

    const cookies = await page.cookies();
    const khrf = cookies.find((c) => c.name === "khrf")?.value ?? null;
    if (khrf) console.log("자동 로그인 성공");
    else console.log("자동 로그인 완료, 쿠키 없음");
    return khrf;
  } catch (e) {
    console.error("브라우저 로그인 실패:", e.message);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

// 세션 복구: 브라우저 로그인 → 게스트 khrf 순으로 시도
async function recoverSession() {
  if (session.memb_id && session.memb_pw) {
    const khrf = await loginWithBrowser();
    if (khrf) { session.khrf = khrf; return true; }
  }
  const fresh = await fetchFreshKhrf();
  if (fresh) { session.khrf = fresh; return true; }
  return false;
}

async function checkRooms({ bran_cd, checkin, checkout, adult_cnt = 2, child_cnt = 0 }) {
  const client = makeClient();
  const urlEncoded = { headers: { "Content-Type": "application/x-www-form-urlencoded" } };
  const form = (obj) => new URLSearchParams(obj).toString();

  const r1 = await client.post("/reservation/membno_select", form({ memb_no: session.memb_no }), urlEncoded);
  const r2 = await client.post("/reservation/branch_select", form({ bran_cd, memb_no: session.memb_no }), urlEncoded);

  const refreshed = extractKhrf(r2) ?? extractKhrf(r1);
  if (refreshed) session.khrf = refreshed;

  const params = new URLSearchParams({
    search_bran_cd: bran_cd,
    search_stay_start_dt: checkin,
    search_stay_end_dt: checkout,
    search_room_cnt: 1,
    search_people_adult_cnt: adult_cnt,
    search_people_adult_cnts: adult_cnt,
    search_people_child_cnt: child_cnt,
    search_people_child_cnts: child_cnt,
    search_code_type: "",
    search_code: "",
    pack_cd: "",
    room_type_cd: "",
    memb_no: session.memb_no,
    pay_type: "D",
  });

  const roomResp = await client.get(`/reservation/quick_roomdata_member/?${params}`);
  const refined = extractKhrf(roomResp);
  if (refined) session.khrf = refined;
  const html = roomResp.data;

  const finalUrl = roomResp.request?.res?.responseUrl ?? "";
  if (!finalUrl.includes("quick_roomdata_member")) return { status: "session_expired" };

  if (html.slice(0, 1000).includes("로그인")) return { status: "session_expired" };

  const $ = cheerio.load(html);
  const text = $.text();

  if (NO_ROOM.some((p) => text.includes(p))) return { status: "none" };

  const els = $(".item_list li.item.room");
  if (els.length > 0) {
    const rooms = els.map((_, el) => {
      const name = $(el).find(".title span").first().text().trim();
      const price = $(el).find(".price .num").text().trim();
      return price ? `${name} (₩${price}~)` : name;
    }).get();
    return { status: "available", rooms };
  }

  return { status: "none" };
}

// ============================================================
// Routes
// ============================================================
app.get("/", (_, res) => res.sendFile(join(__dirname, "index.html")));
app.get("/branches", (_, res) => res.sendFile(join(__dirname, "branch-code.json")));

app.post("/api/session", (req, res) => {
  const { khrf, memb_no, memb_id, memb_pw } = req.body;
  if (khrf)    session.khrf    = khrf.trim();
  if (memb_no) session.memb_no = memb_no.trim();
  if (memb_id) session.memb_id = memb_id.trim();
  if (memb_pw) session.memb_pw = memb_pw.trim();
  res.json({ ok: true });
});

app.get("/api/monitor", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const { bran_cd, checkin, checkout, adult_cnt = 2, child_cnt = 0, interval = 5 } = req.query;

  let active = true;
  req.on("close", () => { active = false; });

  const send = (data) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`); };

  // khrf 없으면 시작 전 복구 시도
  if (!session.khrf) await recoverSession();

  let count = 0;
  while (active) {
    count++;
    try {
      let result = await checkRooms({ bran_cd, checkin, checkout, adult_cnt, child_cnt });

      // 세션 만료 시 자동 복구 후 1회 재시도
      if (result.status === "session_expired") {
        const recovered = await recoverSession();
        if (recovered) result = await checkRooms({ bran_cd, checkin, checkout, adult_cnt, child_cnt });
      }

      send({ count, time: new Date().toTimeString().slice(0, 8), ...result });
      if (result.status === "session_expired") break;
    } catch (e) {
      send({ count, time: new Date().toTimeString().slice(0, 8), status: "error", message: e.message });
    }

    // 설정 간격 ±20% 범위에서 초 단위로 무작위 대기
    const intervalSec = Number(interval) * 60;
    const minSec = Math.floor(intervalSec * 0.8);
    const maxSec = Math.floor(intervalSec * 1.2);
    const waitSec = Math.floor(Math.random() * (maxSec - minSec + 1)) + minSec;
    const until = Date.now() + waitSec * 1000;
    while (active && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  res.end();
});

app.listen(Number(PORT), () => console.log(`http://localhost:${PORT}`));
