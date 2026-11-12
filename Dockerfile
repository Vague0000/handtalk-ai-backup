FROM python:3.11-slim

# 1. I-install ang mga system libraries na kailangan ng OpenCV (libGL)
RUN apt-get update && apt-get install -y \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# 2. I-set ang working directory
WORKDIR /app

# 3. Kopyahin at i-install ang Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 4. Kopyahin ang lahat ng files (server.py, models, dashboard, etc.)
COPY . .

# 5. I-run ang app gamit ang gunicorn (port 8080 ang default ng Railway)
CMD ["gunicorn", "--worker-class", "gthread", "--threads", "100", "-w", "1", "-b", "0.0.0.0:8080", "server:app"]