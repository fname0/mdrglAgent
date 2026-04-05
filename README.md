# Инструкция по запуску

## БД

запустить из `database` `docker-compose up`

## backend

установить зависимости из `backend/requirements.txt` ( `pip install -r requirements.txt` )
и выполнить из директории `backend` `uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload`

## agent

пока без токена и прочих методов авторизации запускается файлом `main.py`. Если надо запустить с другой машины - в `REGISTER_URL` и `WS_URL_TEMPLATE` заменить локалхост на айпи. перед этим установить зависимости из `agent/requirements.txt`

## frontend

из директории `frontend` `npm install` -> `npm run dev`