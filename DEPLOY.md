# 对点咨询校招管理系统 — 部署指南

## 项目概览

- **技术栈**: Node.js + Express + SQLite (better-sqlite3)
- **入口文件**: `server.js`
- **启动命令**: `node server.js` 或 `npm start`
- **端口**: 3000 (可通过 `.env` 中的 `PORT` 修改)
- **页面入口**:
  - 候选人/校园大使端: `/` 或 `/index.html`
  - HR 管理端: `/hr.html`

---

## 方案一：Railway.app 部署（推荐 ⭐）

Railway 是最简单的方式，免费额度足够使用。

### 步骤

1. 访问 https://railway.app 并注册/登录（支持 GitHub 登录）
2. 点击 "New Project" → "Deploy from GitHub"
3. 将本项目上传到你的 GitHub 仓库（或用 ZIP 导入）
4. Railway 会自动检测 Node.js 项目并部署
5. 在 Settings → Networking 中获取公开域名（如 `xxx.up.railway.app`）

### 环境变量（在 Railway Dashboard → Variables 中设置）

```
JWT_SECRET=your_random_secret_key_here
PORT=3000
```

### 注意事项
- SQLite 数据库文件 `recruitment.db` 会随部署一起上传，Railway 会保留它
- 如需持久化数据库（避免重部署时丢失数据），需要在 Railway 中添加 Volume 挂载 `/app/data`
- 对应修改 `database.js` 中数据库路径为 `./data/recruitment.db`

---

## 方案二：自建 Linux 服务器部署

### 前提条件
- 一台 Linux 服务器（Ubuntu/CentOS），已开放 3000 端口
- 已安装 Node.js 18+

### 步骤

```bash
# 1. 上传部署包到服务器
scp recruitment-system-deploy.zip user@your-server:/opt/

# 2. 解压并安装依赖
cd /opt
unzip recruitment-system-deploy.zip
cd recruitment-system
npm install

# 3. 修改 .env 中的 JWT_SECRET
echo "JWT_SECRET=$(openssl rand -hex 32)" > .env
echo "PORT=3000" >> .env

# 4. 使用 PM2 守护进程运行
npm install -g pm2
pm2 start server.js --name recruitment
pm2 save
pm2 startup

# 5. 配置 Nginx 反向代理（可选，推荐）
```

### Nginx 配置示例

```nginx
server {
    listen 80;
    server_name recruit.yourcompany.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
    }

    # 上传文件大小限制
    client_max_body_size 20M;
}
```

---

## 方案三：Render.com 部署

1. 访问 https://render.com 注册
2. 创建 "New Web Service"
3. 连接 GitHub 仓库
4. 设置：
   - Build Command: `npm install`
   - Start Command: `node server.js`
5. 在 Environment 中添加 `JWT_SECRET`

---

## 重要提示

### 微信公众号菜单绑定
建议使用 **Railway.app** 或 **自建服务器** 方案，确保 URL 是永久稳定的。

微信菜单需要的页面：
- **候选人投递页**: `https://你的域名/` 或 `https://你的域名/index.html`
- 或直接指向: `https://你的域名/` （会自动跳转到登录/注册页）

### HR 端分享
将 `https://你的域名/hr.html` 发给同事即可。

### 初始 HR 账号
系统内置 HR 账号规则：任意 `@hr-mp.com` 结尾的邮箱，初始密码 `123456`。
例如：`admin@hr-mp.com` / `123456`

### 数据备份
SQLite 数据库文件 `recruitment.db` 包含了所有数据，定期备份此文件即可。
```bash
cp recruitment.db recruitment.db.backup.$(date +%Y%m%d)
```

---

## 常见问题

**Q: 部署后页面打不开？**
A: 检查 `PORT` 配置，确认防火墙/安全组已放行对应端口。

**Q: 上传简历失败？**
A: 检查 `uploads/` 目录是否有写入权限。`chmod 755 uploads/`

**Q: 数据库丢失怎么办？**
A: Railway/Render 重部署可能导致 SQLite 数据丢失。建议配置 Volume 挂载或定期备份。
