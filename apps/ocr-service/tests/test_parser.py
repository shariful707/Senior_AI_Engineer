import io
import zipfile
from pathlib import Path

import pytest
from app.main import app
from app.parser import detect_type, parse_document
from fastapi.testclient import TestClient
from PIL import Image
from pymupdf import FileDataError

FIXTURES = Path(__file__).resolve().parents[3] / 'eval' / 'fixtures'


def parse(name):
    return parse_document((FIXTURES / name).read_bytes(), name)


def test_digital_and_multipage_pdf():
    result = parse('digital-2.pdf')
    assert len(result['pages']) == 3
    assert 'INV-1002' in result['pages'][0]['raw_text']
    assert all(p['method'] == 'pdf_text' for p in result['pages'])


@pytest.mark.parametrize('name', ['image-7.png', 'image-8.jpg', 'image-9.tiff', 'scanned.pdf'])
def test_real_tesseract_ocr(name):
    result = parse(name)
    assert result['pages'][0]['method'] == 'ocr'
    assert 'Supplier' in result['pages'][0]['raw_text']
    assert result['pages'][0]['ocr_confidence'] > 0


@pytest.mark.parametrize('name', ['ledger.xlsx', 'ledger.xls', 'ledger.csv'])
def test_ledgers_preserve_all_records(name):
    result = parse(name)
    assert len(result['ledger_rows']) == 3
    assert result['ledger_rows'][0]['invoice_number'] == 'INV-1001'
    assert result['ledger_rows'][2]['total'] == 1390
    if name.endswith('xlsx'):
        assert {p['sheet_name'] for p in result['pages']} == {'September', 'Exceptions'}


@pytest.mark.parametrize('name', ['corrupted.pdf', 'blank.pdf'])
def test_corrupted_and_blank_are_explicit_failures(name):
    with pytest.raises((ValueError, FileDataError)):
        parse(name)


def test_extension_spoofing_and_non_workbook_zip_rejected():
    with pytest.raises(ValueError):
        detect_type(b'plain text', 'spoofed.pdf')
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, 'w') as file:
        file.writestr('hello.txt', 'not an Excel file')
    with pytest.raises(ValueError, match='not an Excel'):
        parse_document(archive.getvalue(), 'fake.xlsx')


def test_1000_pages_are_parsed_without_ocr():
    result = parse('large-1000-pages.pdf')
    assert result['page_count'] == 1000
    assert all(p['method'] == 'pdf_text' for p in result['pages'])


def test_tiff_multiframe():
    stream = io.BytesIO()
    with Image.open(FIXTURES / 'image-9.tiff') as image:
        image.save(stream, format='TIFF', save_all=True, append_images=[image])
    assert parse_document(stream.getvalue(), 'two.tiff')['page_count'] == 2


def test_http_parse_failure_does_not_crash_service():
    with TestClient(app) as client:
        res = client.post('/parse', files={'file': ('broken.pdf', b'%PDF-broken', 'application/pdf')})
        assert res.status_code == 422
        assert client.get('/health').status_code == 200
