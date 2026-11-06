from flask import Flask
app = Flask(__name__)
app.config.update(SECRET_KEY="s3cr3t", DATABASE_PASSWORD="pw", API_TOKEN="t", NAME="demo")
