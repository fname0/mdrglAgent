# Инструкция по запуску

## БД

запустить из `database` `docker-compose up`

## backend

установить зависимости из `backend/requirements.txt` ( `pip install -r requirements.txt` )
создать в директории `backend` файл `.env` со следующим содержимым:
```
TELEGRAM_BOT_TOKEN=
OPENROUTER_API_KEY=
OPENROUTER_MODEL=qwen/qwen3.6-plus:free
OPENROUTER_TIMEOUT_SECONDS=90
```

`TELEGRAM_BOT_TOKEN` брать у [BotFather](t.me/BotFather) (написать `/newbot` - после введения никнейма и юзернейма бота выдаст токен)
`OPENROUTER_API_KEY` брать [здесь](https://openrouter.ai/qwen/qwen3.6-plus:free/api), нажав `Create API key`


и выполнить из директории `backend` `uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload`

## agent

пока без токена и прочих методов авторизации запускается файлом `main.py`. Если надо запустить с другой машины - в `REGISTER_URL` и `WS_URL_TEMPLATE` заменить локалхост на айпи. перед этим установить зависимости из `agent/requirements.txt`

## frontend

из директории `frontend` `npm install` -> `npm run dev`