"""Local English embeddings and document parsing. No cloud embedding exists, so there is nothing to fall back to.
BAAI/bge-small-en-v1.5 at one pinned commit: the publisher's FP32 ONNX export on the CPU execution provider, CLS pooling and
L2 normalization (1_Pooling/config.json and modules.json at that commit), the publisher's query instruction and plain passages.
Run as a script (the Compose `models` service) to download the pinned files once into the model volume."""
import hashlib
import io
import json
import os
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

MODEL, REVISION = 'BAAI/bge-small-en-v1.5', '5c38ec7c405ec4b44b94cc5a9bb96e735b38267a'
# Every file is pinned by SHA-256, checked after download and again at every worker start.
FILES = {
    'onnx/model.onnx': '828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35',
    'tokenizer.json': 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66',
    '1_Pooling/config.json': 'd1caf60c96f5fba2157c0c26b76d80818fad6cf0b8eb5e73ec372ff9818eba5c',
    'modules.json': '84e40c8e006c9b1d6c122e02cba9b02458120b5fb0c87b746c41e0207cf642cf',
}
ROOT = Path(os.environ.get('MODEL_DIR', '/models')) / MODEL / REVISION
INSTRUCTION = 'Represent this sentence for searching relevant passages: '
# Passages pack whole lines up to this many tokens (BGE tokenizer, no special tokens), never across PDF pages;
# with [CLS]/[SEP] every passage stays far inside the model's 512-token input.
PASSAGE_TOKENS, MAX_TOKENS = 350, 512
MAX_DOCUMENT_XML = 50 * 1024 * 1024


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as file:
        while block := file.read(1 << 20):
            digest.update(block)
    return digest.hexdigest()


def cached(name):
    path = ROOT / name
    return path.exists() and sha256(path) == FILES[name]


def download():
    for name, expected in FILES.items():
        if cached(name):
            continue
        path = ROOT / name
        path.parent.mkdir(parents=True, exist_ok=True)
        partial = path.with_name(path.name + '.part')
        print(f'Downloading {MODEL}@{REVISION[:7]} {name}', flush=True)
        with urllib.request.urlopen(f'https://huggingface.co/{MODEL}/resolve/{REVISION}/{name}', timeout=60) as response, open(partial, 'wb') as file:
            while block := response.read(1 << 20):
                file.write(block)
        if sha256(partial) != expected:
            partial.unlink()
            sys.exit(f'Downloaded {name} does not match its pinned SHA-256; nothing was cached')
        partial.rename(path)
    print(f'Embedding model {MODEL}@{REVISION} cached and verified', flush=True)


class Unreadable(Exception):
    """The document has no usable text; its version fails visibly."""


class Embedder:
    def __init__(self):
        for name in FILES:
            if not cached(name):
                sys.exit(f'Embedding model file {name} is missing or changed in the model cache ({ROOT}). '
                         'There is no cloud embedding fallback. Run `docker compose run --rm models` once with network access.')
        import numpy
        import onnxruntime
        from tokenizers import Tokenizer
        self.numpy = numpy
        onnxruntime.disable_telemetry_events()
        onnxruntime.set_default_logger_severity(3)
        options = onnxruntime.SessionOptions()
        options.intra_op_num_threads = min(4, os.cpu_count() or 1)
        self.session = onnxruntime.InferenceSession(str(ROOT / 'onnx/model.onnx'), options, providers=['CPUExecutionProvider'])
        # Configured once here, before any thread uses it: never truncate or pad behind our back.
        self.tokenizer = Tokenizer.from_file(str(ROOT / 'tokenizer.json'))
        self.tokenizer.no_truncation()
        self.tokenizer.no_padding()
        self.cls, self.sep = self.tokenizer.token_to_id('[CLS]'), self.tokenizer.token_to_id('[SEP]')
        self.instruction = self.tokenizer.encode(INSTRUCTION, add_special_tokens=False).ids
        self.encoding = json.dumps({
            'model': MODEL, 'revision': REVISION, 'files': FILES, 'runtime': f'onnxruntime {onnxruntime.__version__} CPUExecutionProvider',
            'dtype': 'float32', 'dimensions': 384, 'pooling': 'cls', 'normalize': True, 'query_instruction': INSTRUCTION,
            'passages': f'plain; whole lines packed to {PASSAGE_TOKENS} tokens, page-bounded, no overlap'}, sort_keys=True)

    def vectors(self, rows):
        """Embeddings for token-id rows that already include [CLS]/[SEP]: CLS pooling, L2-normalized float32."""
        np = self.numpy
        ids = np.zeros((len(rows), max(map(len, rows))), np.int64)
        mask = np.zeros_like(ids)
        for i, row in enumerate(rows):
            ids[i, :len(row)], mask[i, :len(row)] = row, 1
        hidden = self.session.run(None, {'input_ids': ids, 'attention_mask': mask, 'token_type_ids': np.zeros_like(ids)})[0][:, 0]
        return hidden / np.linalg.norm(hidden, axis=1, keepdims=True)

    def query(self, text):
        # A long Customer message loses its end, never the instruction.
        ids = self.tokenizer.encode(text, add_special_tokens=False).ids[:MAX_TOKENS - 2 - len(self.instruction)]
        return self.vectors([[self.cls, *self.instruction, *ids, self.sep]])[0]

    def passages(self, pages, tick=lambda: None):
        """[(page, text)] -> [(page, passage, token ids with specials)]. tick() runs once per page."""
        result = []
        for page, text in pages:
            tick()
            pieces = []
            for line in filter(None, (' '.join(line.split()) for line in text.split('\n'))):
                encoded = self.tokenizer.encode(line, add_special_tokens=False)
                # An over-long line splits at token boundaries.
                for start in range(0, len(encoded.ids), PASSAGE_TOKENS):
                    window = encoded.offsets[start:start + PASSAGE_TOKENS]
                    pieces.append((line[window[0][0]:window[-1][1]], len(window)))
            current, size = [], 0
            for piece, count in pieces + [(None, PASSAGE_TOKENS + 1)]:
                if current and (piece is None or size + count > PASSAGE_TOKENS):
                    passage = '\n'.join(current)
                    ids = self.tokenizer.encode(passage).ids
                    if len(ids) > MAX_TOKENS:
                        raise Unreadable('a passage exceeded the model\'s 512-token input')
                    result.append((page, passage, ids))
                    current, size = [], 0
                if piece is not None:
                    current.append(piece)
                    size += count
        return result


def clean(text):
    # PostgreSQL text cannot hold NUL; other control characters carry no meaning here.
    return re.sub(r'[\x00-\x08\x0b-\x1f\x7f]', ' ', text).strip()


def parse(fmt, data, tick=lambda: None):
    """Readable text as [(page or None, text)]; anything unreadable raises Unreadable. tick() runs once per PDF page."""
    if fmt == 'pdf':
        import pypdf
        if not data.startswith(b'%PDF-'):
            raise Unreadable('the file is not a PDF')
        try:
            reader = pypdf.PdfReader(io.BytesIO(data))
            if reader.is_encrypted and not reader.decrypt(''):
                raise Unreadable('the PDF is password-protected')
            pages = []
            for number, page in enumerate(reader.pages, 1):
                tick()
                pages.append((number, clean(page.extract_text() or '')))
        except Unreadable:
            raise
        except Exception:
            raise Unreadable('the PDF could not be read')
        blank = [str(number) for number, text in pages if not text]
        # Any page without text fails the whole file, so no partly scanned document is reported as ingested.
        if not pages or blank:
            raise Unreadable(f'{len(blank)} of {len(pages)} PDF pages have no extractable text (page {", ".join(blank[:10])}'
                             f'{", …" if len(blank) > 10 else ""}; scanned pages need OCR, which is not supported)')
        return pages
    if fmt == 'docx':
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                info = archive.getinfo('word/document.xml')
                if info.file_size > MAX_DOCUMENT_XML:
                    raise Unreadable('the DOCX text is too large')
                xml = archive.read(info)
            if b'<!DOCTYPE' in xml:
                raise Unreadable('the DOCX contains a document type declaration')
            w = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
            text = '\n'.join(''.join(node.text or '' for node in paragraph.iter(f'{w}t')) for paragraph in ET.fromstring(xml).iter(f'{w}p'))
        except Unreadable:
            raise
        except Exception:
            raise Unreadable('the DOCX could not be read')
    else:
        try:
            text = data.decode('utf-8-sig')
        except UnicodeDecodeError:
            raise Unreadable('the file is not UTF-8 text')
        if '\x00' in text:
            raise Unreadable('the file is not text')
    text = clean(text)
    if not text:
        raise Unreadable('the document has no readable text')
    return [(None, text)]


if __name__ == '__main__':
    download()
