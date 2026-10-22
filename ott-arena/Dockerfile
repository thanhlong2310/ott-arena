FROM node:20-bookworm-slim

# Cài đặt Python 3, trình biên dịch C++ (g++) và công cụ sandbox Bubblewrap
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    g++ \
    bubblewrap \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy khai báo phụ thuộc và cài đặt
COPY package*.json ./
RUN npm install --omit=dev

# Copy toàn bộ mã nguồn vào image
COPY . .

# Thiết lập thư mục dữ liệu và quyền truy cập
RUN mkdir -p data public

# Mở cổng mặc định (Render tự truyền PORT qua biến môi trường)
ENV PORT=3000
EXPOSE 3000

# Khởi động OTT Arena Game Server
CMD ["npm", "start"]
