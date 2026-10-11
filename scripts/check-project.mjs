import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const dataMatch = html.match(/let users=(\[.*?\]); let orders=(\[.*?\]); let filter=/s);
const columnMatch = html.match(/const USER_COLS=(\[.*?\]); const ORDER_COLS=(\[.*?\]);/s);

if (!dataMatch || !columnMatch) {
  throw new Error("无法识别 V1.9 的内嵌数据或字段定义");
}

const users = JSON.parse(dataMatch[1]);
const orders = JSON.parse(dataMatch[2]);
const userColumns = JSON.parse(columnMatch[1]);
const orderColumns = JSON.parse(columnMatch[2]);
const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1])
  .filter((script) => script.trim());

for (const script of inlineScripts) {
  new Function(script);
}

const camIds = users.map((row) => String(row["转化CAM"] || ""));
const uniqueCamIds = new Set(camIds);

if (camIds.some((id) => !id)) {
  throw new Error("样例数据存在空的转化CAM");
}

if (camIds.length !== uniqueCamIds.size) {
  throw new Error("样例数据存在重复的转化CAM");
}

console.log("项目检查通过");
console.log(`用户样例：${users.length} 条，展示字段：${userColumns.length} 个`);
console.log(`订单样例：${orders.length} 条，字段：${orderColumns.length} 个`);
console.log(`内联脚本：${inlineScripts.length} 个，JavaScript 语法正常`);
