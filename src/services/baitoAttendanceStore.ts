import fs from "fs";
import path from "path";

const STORE_PATH = "data/baito-attendance.json";

interface AttendanceRecord {
  date: string; // YYYY-MM-DD
  userIds: string[];
}

function ensureStoreDir() {
  const dir = path.dirname(STORE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getTodayString() {
  const now = new Date();
  now.setUTCHours(now.getUTCHours() + 7); // WIB
  return now.toISOString().split("T")[0];
}

export function getAttendanceStore(): AttendanceRecord {
  ensureStoreDir();
  if (!fs.existsSync(STORE_PATH)) {
    return { date: getTodayString(), userIds: [] };
  }
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    const today = getTodayString();
    if (parsed.date !== today) {
      // Reset for a new day
      return { date: today, userIds: [] };
    }
    return parsed as AttendanceRecord;
  } catch (err) {
    return { date: getTodayString(), userIds: [] };
  }
}

export function saveAttendanceStore(record: AttendanceRecord) {
  ensureStoreDir();
  fs.writeFileSync(STORE_PATH, JSON.stringify(record, null, 2), "utf-8");
}

export function hasAttendedToday(userId: string): boolean {
  const store = getAttendanceStore();
  return store.userIds.includes(userId);
}

export function markAttendedToday(userId: string) {
  const store = getAttendanceStore();
  if (!store.userIds.includes(userId)) {
    store.userIds.push(userId);
    saveAttendanceStore(store);
  }
}
