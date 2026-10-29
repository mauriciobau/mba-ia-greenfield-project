const { open } = require('node:fs/promises');

process.on('message', async (message) => {
  if (message?.type !== 'upload') return;

  let file;
  try {
    file = await open(message.fixturePath, 'r');
    const buffer = Buffer.alloc(message.partSizeBytes);
    for (const part of message.parts) {
      const start = (part.partNumber - 1) * message.partSizeBytes;
      const length = Math.min(
        message.partSizeBytes,
        (await file.stat()).size - start,
      );
      await file.read(buffer, 0, length, start);
      const response = await fetch(part.url, {
        method: 'PUT',
        body: buffer.subarray(0, length),
      });
      if (response.status !== 200) {
        throw new Error(
          `Part ${part.partNumber} upload returned HTTP ${response.status}`,
        );
      }
      await response.body?.cancel();
    }
    process.send({ type: 'complete' }, () => process.disconnect());
  } catch (error) {
    process.send(
      {
        type: 'error',
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      },
      () => process.disconnect(),
    );
  } finally {
    await file?.close();
  }
});
