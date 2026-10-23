"""Durable benchmark artifacts and an OS-held, host-local execution exclusion."""
import json
import os
from pathlib import Path


def atomic_json(path, value):
    path=Path(path)
    temporary=path.with_suffix(path.suffix+'.tmp')
    with temporary.open('w',encoding='utf-8') as stream:
        json.dump(value,stream,ensure_ascii=False,allow_nan=False,indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary,path)


class ExecutionLock:
    """Never delete a held lock or terminate a PID read from disk."""
    def __init__(self, directory):
        self.directory=Path(directory)
        self.handle=None

    def __enter__(self):
        self.directory.mkdir(parents=True,exist_ok=True)
        handle=(self.directory/'.benchmark.lock').open('a+b')
        try:
            if handle.tell()==0:
                handle.write(b'0'); handle.flush()
            handle.seek(0)
            if os.name=='nt':
                import msvcrt
                msvcrt.locking(handle.fileno(),msvcrt.LK_NBLCK,1)
            else:
                import fcntl
                fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except Exception:
            handle.close()
            raise RuntimeError('Another benchmark is running; lock was not acquired')
        self.handle=handle
        return self

    def __exit__(self,*args):
        self.handle.close()
