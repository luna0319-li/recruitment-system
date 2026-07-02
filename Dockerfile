FROM node:20-bookworm

# 安装构建 better-sqlite3 所需的依赖
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    build-essential \
    libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 复制 package 文件并安装依赖
COPY package*.json ./
RUN npm install

# 复制项目代码
COPY . .

# 创建上传目录和数据库目录
RUN mkdir -p uploads data

# 暴露端口
EXPOSE 3000

# 启动命令
CMD ["node", "server.js"]
