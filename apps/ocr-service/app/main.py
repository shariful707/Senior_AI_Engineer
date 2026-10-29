import hmac
import os
from typing import Annotated

from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool

from .parser import parse_document

app = FastAPI(title='Document parsing service', version='1.0.0')
TOKEN = os.getenv('INTERNAL_TOKEN', '')
MAX_BYTES = int(os.getenv('MAX_UPLOAD_MB', '25')) * 1024 * 1024


@app.get('/health')
def health():
    return {'status': 'ok'}


@app.post('/parse')
async def parse(file: Annotated[UploadFile, File()], x_internal_token: Annotated[str, Header()] = ''):
    if TOKEN and not hmac.compare_digest(TOKEN, x_internal_token):
        raise HTTPException(401, 'Invalid internal token')
    data = await file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise HTTPException(413, 'File exceeds upload limit')
    try:
        return await run_in_threadpool(parse_document, data, file.filename or '')
    except Exception as exc:
        raise HTTPException(422, f'{type(exc).__name__}: {exc}') from exc
