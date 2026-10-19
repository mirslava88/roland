import { app } from 'electron'
import { join } from 'path'
import { Worker } from 'worker_threads'

export function macNativeOffice<T>(action: string, args: unknown[], timeoutMs = 15_000): Promise<T> {
  const module = app.isPackaged ? join(process.resourcesPath, 'mac-office-accessibility.node')
    : join(__dirname, '../../build/mac-office-accessibility.node')
  return new Promise<T>((resolve, reject) => {
    const worker = new Worker(`const {parentPort,workerData}=require('worker_threads');
      try {
        const native=require(workerData.module); let value;
        for(let attempt=0;;attempt++) {
          try { value=native[workerData.action](...workerData.args); break }
          catch(error) {
            if(workerData.action!=='releaseDocumentWindow'||attempt>=4||!String(error).includes('matches=0'))throw error;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,150);
          }
        }
        parentPort.postMessage({value})
      } catch(error){parentPort.postMessage({error:String(error)})}`, {eval:true,workerData:{module,action,args}})
    let settled = false
    const finish = (error?: Error, value?: T): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      if (error) reject(error); else resolve(value as T)
    }
    const timer = setTimeout(() => finish(new Error(`Office operation timed out: ${action}`)), timeoutMs)
    worker.once('message', (result: {value?:T;error?:string}) => finish(result.error ? new Error(result.error) : undefined, result.value))
    worker.once('error', error => finish(error))
    worker.once('exit', code => { if (!settled) finish(new Error(`Office worker exited: ${code}`)) })
  })
}

export async function keynoteNative<T>(pid: number, action: string, ...args: (string | number)[]): Promise<T> {
  const result = await macNativeOffice<string>('keynoteControl', [pid, action, JSON.stringify(args)], action === 'exportpdf' ? 120_000 : action === 'import' ? 60_000 : 20_000)
  return JSON.parse(result) as T
}
