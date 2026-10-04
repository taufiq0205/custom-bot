FROM python:3.14.6-slim-bookworm@sha256:4c92ffcde4dd6f1ff72a24518f49fd4990b27134987dfa31a733badde66df9f8
WORKDIR /worker
COPY requirements.lock ./
RUN pip install --no-cache-dir --require-hashes -r requirements.lock
# The model volume starts owned by the worker user, so the models service can fill it.
RUN mkdir /models && chown 10001:10001 /models
COPY worker.py knowledge.py memory.py ./
USER 10001:10001
CMD ["python","worker.py"]
