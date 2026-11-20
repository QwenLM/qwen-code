#!/usr/bin/env python3
"""Assemble the twelve native production modules after their real Maven build."""
from pathlib import Path
import argparse,copy,hashlib,json,zipfile,xml.etree.ElementTree as E
ap=argparse.ArgumentParser();ap.add_argument('--source',type=Path,required=True);ap.add_argument('--out',type=Path,required=True);ap.add_argument('--revision',required=True);ap.add_argument('--version',required=True);ap.add_argument('--sdk-version',required=True);a=ap.parse_args()
ns='http://maven.apache.org/POM/4.0.0';N={'m':ns};E.register_namespace('',ns)
def q(s):return '{'+ns+'}'+s
def text(e,k,default=''):return e.findtext('m:'+k,default,N)
root=a.source/'packages/managed-agent-server';parent=E.parse(root/'pom.xml').getroot();native_version=text(parent,'version');mods=[m.text for m in parent.findall('m:modules/m:module',N) if m.text!='verification'];assert len(mods)==12,mods
entries={};services={};inputs=[];deps={};sdk_version=a.sdk_version;group='com.aliyun.dataworks.agent.preview'
for mod in mods:
 p=E.parse(root/mod/'pom.xml').getroot();artifact=text(p,'artifactId');jar=root/mod/'target'/f'{artifact}-{native_version}.jar';assert jar.is_file(),jar
 inputs.append({'module':mod,'jar':str(jar.relative_to(a.source)),'sha256':hashlib.sha256(jar.read_bytes()).hexdigest()})
 with zipfile.ZipFile(jar) as z:
  assert not any(n.startswith('BOOT-INF/') for n in z.namelist()),jar
  for info in z.infolist():
   name=info.filename
   if info.is_dir() or name.upper()=='META-INF/MANIFEST.MF':continue
   assert not name.upper().endswith(('.SF','.RSA','.DSA')),name
   payload=z.read(name)
   if name.startswith('META-INF/services/'):
    services.setdefault(name,set()).update(line.split('#',1)[0].strip() for line in payload.decode().splitlines() if line.split('#',1)[0].strip());continue
   if name in entries and entries[name]!=payload:raise ValueError('Conflicting resource: '+name)
   entries[name]=payload
 for d in p.findall('m:dependencies/m:dependency',N):
  gav=(text(d,'groupId'),text(d,'artifactId'),text(d,'type','jar'),text(d,'classifier'))
  scope=text(d,'scope','compile')
  if gav[1].startswith('qwen-managed-agent-') or scope in ['test','provided']:continue
  d=copy.deepcopy(d)
  if gav[:2]==('com.alibaba','qwencode-sdk'):
   d.find('m:groupId',N).text=group
   v=d.find('m:version',N)
   if v is None:v=E.SubElement(d,q('version'))
   v.text=sdk_version;gav=(group,gav[1],gav[2],gav[3])
  if gav in deps:
   previous=deps[gav]
   assert text(previous,'version')==text(d,'version'),gav
   if text(previous,'scope','compile')=='runtime' and scope=='compile':deps[gav]=d
  else:deps[gav]=d
for name,providers in services.items():entries[name]=('\n'.join(sorted(providers))+'\n').encode()
provider_name='META-INF/services/com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderFactory'
assert len(services.get(provider_name,set()))==4,services.get(provider_name)
for provider in services[provider_name]:assert provider.replace('.','/')+'.class' in entries,provider
schema='db/managed-schema/V1__managed_schema.sql';assert entries[schema]==(root/'persistence/src/main/resources'/schema).read_bytes()
result_contract='contracts/managed-tool-result-v1.schema.json'
assert entries[result_contract]==(a.source/'packages/core/src/managed-runtime/contracts/managed-tool-result-v1.schema.json').read_bytes()
assert not any('/verification/' in n or n.startswith('BOOT-INF/') for n in entries)
manifest=f'Manifest-Version: 1.0\r\nImplementation-Title: Qwen Managed Agent Server preview\r\nImplementation-Version: {a.version}\r\nSource-Revision: {a.revision}\r\n\r\n';entries['META-INF/MANIFEST.MF']=manifest.encode()
# Freeze a normal consumer POM with every native external production dependency.
p=E.Element(q('project'));E.SubElement(p,q('modelVersion')).text='4.0.0';p.append(copy.deepcopy(parent.find('m:parent',N)))
for k,v in [('groupId',group),('artifactId','qwen-managed-agent-server'),('version',a.version),('packaging','jar'),('name','Qwen Managed Agent Server private preview')]:E.SubElement(p,q(k)).text=v
for k in ['licenses','properties','dependencyManagement']:
 e=parent.find('m:'+k,N)
 if e is not None:p.append(copy.deepcopy(e))
mgmt=p.find('m:dependencyManagement/m:dependencies',N)
if mgmt is not None:
 for d in list(mgmt):
  if text(d,'artifactId').startswith('qwen-managed-agent-') or (text(d,'groupId'),text(d,'artifactId'))==('com.alibaba','qwencode-sdk'):mgmt.remove(d)
ds=E.SubElement(p,q('dependencies'))
for gav,d in sorted(deps.items()):ds.append(d)
a.out.mkdir(parents=True,exist_ok=True);name=f'qwen-managed-agent-server-{a.version}';pom=a.out/(name+'.pom');E.indent(p);E.ElementTree(p).write(pom,encoding='UTF-8',xml_declaration=True)
jar=a.out/(name+'.jar')
# Spring scans package resources, so the assembled JAR needs their directory entries.
directories=set()
for path in entries:
 parts=path.split('/')
 directories.update('/'.join(parts[:i])+'/' for i in range(1,len(parts)))
with zipfile.ZipFile(jar,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
 for path in sorted(set(entries)|directories):
  info=zipfile.ZipInfo(path,date_time=(2000,1,1,0,0,0))
  if path in directories:
   info.compress_type=zipfile.ZIP_STORED;info.external_attr=(0o40755<<16)|0x10;payload=b''
  else:
   info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o100644<<16;payload=entries[path]
  z.writestr(info,payload)
with zipfile.ZipFile(jar) as z:
 assert all(z.getinfo(path).is_dir() for path in directories)
 assert z.getinfo('com/alibaba/qwen/code/managedagent/').is_dir()
report={'sourceRevision':a.revision,'coordinate':f'{group}:qwen-managed-agent-server:{a.version}','sdk':f'{group}:qwencode-sdk:{sdk_version}','modules':inputs,'services':{n:sorted(v) for n,v in services.items()},'entries':len(entries),'directoryEntries':len(directories),'schemaSha256':hashlib.sha256(entries[schema]).hexdigest(),'jarSha256':hashlib.sha256(jar.read_bytes()).hexdigest(),'pomSha256':hashlib.sha256(pom.read_bytes()).hexdigest()}
# Freeze the matching SDK JAR and its real external dependency POM.
sdk_root=a.source/'packages/sdk-java/qwencode';sdk_pom=E.parse(sdk_root/'pom.xml').getroot()
sdk_native_version=text(sdk_pom,'version');sdk_input=sdk_root/'target'/f'qwencode-sdk-{sdk_native_version}.jar';assert sdk_input.is_file(),sdk_input
sdk_out=a.out/'sdk';sdk_out.mkdir();sdk_name=f'qwencode-sdk-{sdk_version}';sdk_jar=sdk_out/(sdk_name+'.jar');sdk_jar.write_bytes(sdk_input.read_bytes())
sdk_pom.find('m:groupId',N).text=group;sdk_pom.find('m:version',N).text=sdk_version
props=sdk_pom.find('m:properties',N)
if props is None:props=E.SubElement(sdk_pom,q('properties'))
E.SubElement(props,q('qwen.source.revision')).text=a.revision
sdk_pom_path=sdk_out/(sdk_name+'.pom');E.indent(sdk_pom);E.ElementTree(sdk_pom).write(sdk_pom_path,encoding='UTF-8',xml_declaration=True)
report['sdkJarSha256']=hashlib.sha256(sdk_jar.read_bytes()).hexdigest();report['sdkPomSha256']=hashlib.sha256(sdk_pom_path.read_bytes()).hexdigest()
(a.out/'assembly-validation.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({k:v for k,v in report.items() if k not in ['modules','services']},indent=2))
