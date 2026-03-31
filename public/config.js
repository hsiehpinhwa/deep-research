// public/config.js
// 部署前將 API_URL 改為 Railway 服務的實際 URL
// API calls go through Vercel rewrite proxy → Railway backend
// This avoids direct connection to Railway which may be blocked in some networks
window.API_URL = '';