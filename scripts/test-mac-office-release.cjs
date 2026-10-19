// Actual coordinator with fake Apple events: preserved documents must remain
// controllable after STOP, including an Office window restored by the user.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const { transformSync } = require('esbuild')
let result='released'
let source = fs.readFileSync('src/main/mac-office.ts', 'utf8')
source += '\nexport const __test = { documents, setCommand(fn) { command=fn } }'
const moduleObject = { exports: {} }
const dependencies = {
 './mac-native-office': { macNativeOffice: async (action) => action==='managedOfficeWindows'?[]:{windowId:1,pid:2,windowGone:result==='closed'} }, electron: {}, './paths': { scriptPath: () => '/fake' }, './diagnostic-log': { diagnosticLog() {} }
}
vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, {
 module:moduleObject,exports:moduleObject.exports,console,process,Buffer,__dirname,
 require:name => Object.hasOwn(dependencies,name)?dependencies[name]:require(name)
})
const { macOffice, __test } = moduleObject.exports
;(async()=>{
 const calls=[]
 result='released'
 __test.setCommand(async args=>{calls.push(args);return result})
 __test.documents.set('/user.docx',{family:'word',marker:'PDM owned',owned:false,originalCaption:'User',originalBounds:[-1920,0,0,1080]})
 assert.equal((await macOffice.release('/user.docx')).success,true)
 assert.equal(__test.documents.has('/user.docx'),true,'preserved Word window must stay tracked')
 await macOffice.release()
 assert.equal(calls.length,2,'next STOP must hide a previously released document too')
 result='closed'
 await macOffice.release()
 assert.equal(__test.documents.size,0,'closed documents must be forgotten')
 __test.documents.set('/edited.xlsx',{family:'excel',owned:true,marker:'PDM edited',originalCaption:'Edited',originalBounds:[0,0,100,100]})
 __test.setCommand(async()=>{throw Error('Office denied minimize')})
 assert.equal((await macOffice.release()).success,false)
 assert.equal(__test.documents.size,1,'failed release must be retryable')
 console.log('PASS: Word/Excel remain tracked after preserved release; closed documents retire; failed STOP is retryable')
})().catch(error=>{console.error(error);process.exitCode=1})
