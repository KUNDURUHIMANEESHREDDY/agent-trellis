import { useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, ArrowUpRight, Bot, Boxes, Cable, ChevronDown, CircleHelp, Command, Database, FileCheck2, Gauge, GitBranch, Layers3, Network, Play, RefreshCw, Search, ShieldAlert, ShieldCheck, Sparkles, TerminalSquare, Zap } from "lucide-react";

type NodeItem = { id: string; labels: string[]; properties: Record<string, any> };
type GraphData = { nodes: NodeItem[]; edges: { source: string; target: string; type: string }[] };
type Overview = { agents: number; mcpServers: number; discoveredMcpServers: number; tools: number; capabilities: number; policies: number; evidence: number; failedFindings: number; highRiskTools: number; analyzedMcpTools?: number; criticalMcpTools?: number };
type CapabilityIntelligence = { summary: { servers: number; analyzedServers: number; tools: number; analyzedTools: number; highRiskTools: number; criticalTools: number; unassociatedServers: number; capabilities: number }; capabilities: Record<string, any>[]; servers: Array<Record<string, any>> };
type DiscoveredMcpServer = { id: string; name: string; hostName: string; hostSource: string; source: string; configPath: string; configScope: string; transport: string; command?: string; endpoint?: string; argumentCount: number; environmentKeys: string[]; headerNames: string[]; credentialHints: boolean };
type MCPInspectionView = { id: string; serverId: string; serverName: string; result: string; severity: string; inspectedAt: string; transport: string; protocolEra: string; protocolVersion: string; serverInfoJson?: string; instructions?: string; declaredCapabilitiesJson?: string; observedCapabilitiesJson?: string; capabilityComparisonsJson?: string; errorSummary?: string; tools: Array<Record<string, unknown>> };
type RuntimeMonitoring = {
  telemetryConfigured: boolean;
  provenance: { gatewayObserved: number; adapterReported: number; independentObserver: number };
  summary: Record<string, number>;
  events: Record<string, any>[];
  independentObservations: { total: number; events: Record<string, any>[] };
  drift: { total: number; events: Record<string, any>[] };
  capabilityDrift: { total: number; permissionEscalations: number; events: Record<string, any>[] };
  blastRadius: { total: number; expanded: number; events: Record<string, any>[] };
  monitorRuns: { total: number; latest: Record<string, any> | null; events: Record<string, any>[] };
  monitorStatus: { enabled: boolean; intervalMs: number; includeStdio: boolean; running: boolean; lastRun?: Record<string, any> };
};
const api = async <T,>(path: string, options?: RequestInit): Promise<T> => {
  const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  if (!response.ok) throw new Error((await response.json()).error || "Request failed");
  return response.json();
};
const positions: Record<string, [number, number]> = {
  "agent-research":[112,100],"agent-support":[112,260],"agent-finance":[112,420],
  "mcp-browser":[340,170],"mcp-crm":[340,330],"mcp-finance":[340,490],
  "tool-search":[570,80],"tool-fetch":[570,180],"tool-customer":[570,280],"tool-update":[570,380],"tool-balance":[570,480],"tool-payment":[570,580],
  "cap-public-web":[810,130],"cap-customer-pii":[810,280],"cap-ticket-write":[810,390],"cap-finance-read":[810,500],"cap-payment-write":[810,610],
  "policy-domain":[1050,130],"policy-pii":[1050,300],"policy-payment":[1050,600],
  "evidence-001":[570,700],"evidence-002":[810,730],"evidence-003":[1050,760],"evidence-004":[570,800]
};
const meta: Record<string,{color:string;icon:any}> = {
  Agent:{color:"#8b9cff",icon:Bot}, MCPHost:{color:"#74d7c2",icon:Database}, MCPServer:{color:"#4ed6c1",icon:Cable}, Tool:{color:"#f4b75e",icon:Zap},
  Capability:{color:"#b69aff",icon:Layers3}, Policy:{color:"#5bc3ee",icon:ShieldCheck}, Evidence:{color:"#ff777e",icon:FileCheck2}, Incident:{color:"#ff5d66",icon:AlertTriangle}
};
function App() {
  const [overview,setOverview]=useState<Overview|null>(null),[graph,setGraph]=useState<GraphData>({nodes:[],edges:[]});
  const [agents,setAgents]=useState<Record<string,any>[]>([]),[evidence,setEvidence]=useState<Record<string,any>[]>([]);
  const [discoveredServers,setDiscoveredServers]=useState<DiscoveredMcpServer[]>([]),[discoveryDiagnostics,setDiscoveryDiagnostics]=useState<{source:string;configPath:string;message:string}[]>([]);
  const [inspections,setInspections]=useState<MCPInspectionView[]>([]);
  const [capabilityIntelligence,setCapabilityIntelligence]=useState<CapabilityIntelligence>({summary:{servers:0,analyzedServers:0,tools:0,analyzedTools:0,highRiskTools:0,criticalTools:0,unassociatedServers:0,capabilities:0},capabilities:[],servers:[]});
  const [runtimeMonitoring,setRuntimeMonitoring]=useState<RuntimeMonitoring>({
    telemetryConfigured:false,
    provenance:{gatewayObserved:0,adapterReported:0,independentObserver:0},
    summary:{totalEvents:0,callsStarted:0,callsSucceeded:0,callsFailed:0,callsOutcomeUnknown:0,policyDenials:0,sideEffects:0,highSeveritySideEffects:0,gatewayObservedEvents:0,adapterReportedEvents:0,independentSideEffectObservations:0},
    events:[],
    independentObservations:{total:0,events:[]},
    drift:{total:0,events:[]},
    capabilityDrift:{total:0,permissionEscalations:0,events:[]},
    blastRadius:{total:0,expanded:0,events:[]},
    monitorRuns:{total:0,latest:null,events:[]},
    monitorStatus:{enabled:false,intervalMs:0,includeStdio:false,running:false}
  });
  const [associationSelections,setAssociationSelections]=useState<Record<string,string>>({});
  const [selected,setSelected]=useState<NodeItem|null>(null),[impact,setImpact]=useState<any>(null),[busy,setBusy]=useState(false);
  const [notice,setNotice]=useState(""),[view,setView]=useState("Overview"),[query,setQuery]=useState("");
  const refresh=async()=>{const[o,g,a,e,d,i,c,m]=await Promise.all([api<Overview>("/api/overview"),api<GraphData>("/api/graph"),api<any[]>("/api/agents"),api<any[]>("/api/evidence"),api<DiscoveredMcpServer[]>("/api/discovery/mcp"),api<MCPInspectionView[]>("/api/inspection/mcp"),api<CapabilityIntelligence>("/api/capabilities/intelligence"),api<RuntimeMonitoring>("/api/runtime/monitoring")]);setOverview(o);setGraph(g);setAgents(a);setEvidence(e);setDiscoveredServers(d);setInspections(i);setCapabilityIntelligence(c);setRuntimeMonitoring(m);if(selected)setSelected(g.nodes.find(n=>n.id===selected.id)??null);};
  const discover=async()=>{setBusy(true);try{const r=await api<{scannedConfigFiles:number;discoveredServers:number;diagnostics:{source:string;configPath:string;message:string}[];servers:DiscoveredMcpServer[]}>("/api/discovery/mcp",{method:"POST"});setDiscoveredServers(r.servers);setDiscoveryDiagnostics(r.diagnostics);setNotice("Read "+r.scannedConfigFiles+" local configuration file(s) · discovered "+r.discoveredServers+" MCP server definition(s) · no processes started.");await refresh();}catch(e){setNotice(e instanceof Error?e.message:"MCP discovery failed");}finally{setBusy(false);}};
  const inspectServer=async(server:DiscoveredMcpServer)=>{const approveStdio=server.transport==="stdio";setBusy(true);try{if(approveStdio){const preview=await api<{command:string;args:string[];cwd:string;environmentKeys:string[]}>("/api/inspection/mcp/"+encodeURIComponent(server.id)+"/approval-preview");const invocation=[preview.command,...preview.args].map(value=>JSON.stringify(value)).join(" ");const approved=window.confirm("This inspection will execute a local process. Review the command first:\n\n"+invocation+"\n\nWorking directory: "+preview.cwd+"\nEnvironment variable names: "+(preview.environmentKeys.join(", ")||"none")+"\nSensitive-looking values are redacted. Environment values are not displayed.\n\nProtocol negotiation may start a short-lived probe process before the inspection process. No MCP tools will be invoked. Continue?");if(!approved)return;}const result=await api<{result:string;protocolEra?:string;protocolVersion?:string;toolsCount:number;errorSummary?:string}>("/api/inspection/mcp/"+encodeURIComponent(server.id),{method:"POST",body:JSON.stringify({approveStdio})});setNotice(server.name+" · "+result.result+" · "+result.toolsCount+" tool(s) inspected"+(result.errorSummary?" · "+result.errorSummary:""));await refresh();}catch(e){setNotice(e instanceof Error?e.message:"MCP inspection failed");}finally{setBusy(false);}};
  const analyzeCapabilities=async()=>{setBusy(true);try{const result=await api<{analyzedTools:number;summary:CapabilityIntelligence["summary"]}>("/api/capabilities/analyze",{method:"POST"});await refresh();setNotice("Capability inference complete · "+result.analyzedTools+" tool(s) analyzed · "+result.summary.highRiskTools+" high-risk tool(s) identified.");}catch(e){setNotice(e instanceof Error?e.message:"Capability analysis failed");}finally{setBusy(false);}};
  const associateServer=async(serverId:string)=>{const agentId=associationSelections[serverId];if(!agentId)return;setBusy(true);try{await api("/api/agents/"+encodeURIComponent(agentId)+"/mcp-servers/"+encodeURIComponent(serverId),{method:"POST",body:JSON.stringify({})});await refresh();setNotice("MCP server associated with the selected agent.");}catch(e){setNotice(e instanceof Error?e.message:"Association failed");}finally{setBusy(false);}};
  const removeServerAssociation=async(agentId:string,serverId:string)=>{setBusy(true);try{await api("/api/agents/"+encodeURIComponent(agentId)+"/mcp-servers/"+encodeURIComponent(serverId),{method:"DELETE"});await refresh();setNotice("Agent-to-server association removed.");}catch(e){setNotice(e instanceof Error?e.message:"Could not remove association");}finally{setBusy(false);}};
  const runMonitor=async()=>{setBusy(true);try{const result=await api<{inspectedServers:number;failedServers:number;skippedStdioServers:number;busy?:boolean}>("/api/monitor/run",{method:"POST"});await refresh();setNotice("Monitor cycle complete · "+result.inspectedServers+" inspected · "+result.failedServers+" failed · "+result.skippedStdioServers+" stdio server(s) skipped.");}catch(e){setNotice(e instanceof Error?e.message:"Monitor run failed");}finally{setBusy(false);}};
  useEffect(()=>{refresh().catch(e=>setNotice(e.message));},[]);
  const visible=useMemo(()=>graph.nodes.filter(n=>[n.properties.name,n.properties.title,n.properties.id,n.labels[0]].join(" ").toLowerCase().includes(query.toLowerCase())),[graph.nodes,query]);
  const graphLayout=useMemo(()=>{const map:Record<string,[number,number]>={...positions};const hosts=graph.nodes.filter(n=>n.labels.includes("MCPHost")).sort((a,b)=>String(a.properties.name).localeCompare(String(b.properties.name)));const servers=graph.nodes.filter(n=>n.labels.includes("MCPServer")&&n.properties.discovered===true).sort((a,b)=>String(a.properties.name).localeCompare(String(b.properties.name)));const discoveredTools=graph.nodes.filter(n=>n.labels.includes("Tool")&&n.properties.mcpDiscovered===true).sort((a,b)=>String(a.properties.name).localeCompare(String(b.properties.name)));const inferredCapabilities=graph.nodes.filter(n=>n.labels.includes("Capability")&&n.properties.source==="schema-inference").sort((a,b)=>String(a.properties.name).localeCompare(String(b.properties.name)));const rows=Math.max(hosts.length,servers.length,discoveredTools.length,inferredCapabilities.length);hosts.forEach((n,i)=>{map[n.id]=[112,880+i*92];});servers.forEach((n,i)=>{map[n.id]=[340,880+i*92];});discoveredTools.forEach((n,i)=>{map[n.id]=[570,880+i*92];});inferredCapabilities.forEach((n,i)=>{map[n.id]=[810,880+i*92];});return{positions:map,height:Math.max(880,880+rows*92)};},[graph.nodes]);
  const name=(n:NodeItem)=>n.properties.name??n.properties.title??n.properties.id;
  const color=(n:NodeItem)=>meta[n.labels[0]]?.color??"#8793a8";
  const select=async(n:NodeItem)=>{setSelected(n);setImpact(null);if(n.labels.includes("Tool"))try{setImpact(await api("/api/impact/"+n.id));}catch{}};
  const simulate=async(id:string)=>{setBusy(true);try{const r=await api<any>("/api/simulations/"+id+"/compromise",{method:"POST"});setImpact(r);setNotice("Simulation complete · "+r.affectedAgents.length+" connected agent(s) affected");await refresh();}catch(e){setNotice(e instanceof Error?e.message:"Simulation failed");}finally{setBusy(false);}};
  const reset=async()=>{setBusy(true);try{await api("/api/demo/reset",{method:"POST"});setImpact(null);setSelected(null);await refresh();setNotice("Demo graph restored.");}catch(e){setNotice(e instanceof Error?e.message:"Reset failed");}finally{setBusy(false);}};
  return <div className="shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><GitBranch size={19}/></div><div><b>agent<span>trellis</span></b><small>SECURITY INTELLIGENCE</small></div></div>
      <div className="workspace"><div className="workspace-icon">AT</div><div><b>Demo workspace</b><small>Personal environment</small></div><ChevronDown size={15}/></div>
      <div className="nav-label">WORKSPACE</div>
      {([["Overview",Gauge],["Graph explorer",Network],["Agent inventory",Bot],["Evidence",FileCheck2],["Blast radius",ShieldAlert],["MCP discovery",Database],["Capability intelligence",Layers3],["Runtime monitoring",Activity]] as const).map(([label,Icon])=><button key={label} className={"nav-item "+(view===label?"active":"")} onClick={()=>setView(label)}><Icon size={17}/>{label}{label==="Evidence"&&<span className="nav-count">{evidence.length}</span>}</button>)}
      <div className="nav-label nav-spaced">SYSTEM</div>
      <button className="nav-item" onClick={()=>setNotice("Relate embedded graph · persistent local store")}><Database size={17}/>Graph database</button>
      <button className="nav-item" onClick={()=>setNotice("API status: healthy · /api/health")}><TerminalSquare size={17}/>API & integrations</button>
      <div className="sidebar-bottom"><div className="relate-chip"><span className="pulse-dot"/> RELATE CONNECTED <span>●</span></div><div className="user-row"><div className="avatar">R</div><div><b>Workspace owner</b><small>Administrator</small></div><CircleHelp size={17}/></div></div>
    </aside>
    <main className="main">
      <header className="topbar"><div className="breadcrumbs">Workspace <span>/</span> {view}</div><div className="top-actions"><div className="status-pill"><span className="pulse-dot"/> All systems operational</div><button className="icon-button" title="Refresh" onClick={()=>refresh()}><RefreshCw size={16}/></button><button className="icon-button" title="Command menu"><Command size={16}/></button><div className="top-avatar">R</div></div></header>
      <div className="content">
        <div className="page-heading"><div><div className="eyebrow"><Sparkles size={13}/> CONNECTED SECURITY CONTEXT</div><h1>{view==="Overview"?"Agent security overview":view}</h1><p>See how agents, tools, permissions and evidence connect across your environment.</p></div><div className="heading-actions">{view==="MCP discovery"?<button className="button primary" onClick={discover} disabled={busy}><Search size={15}/>{busy?"Scanning...":"Discover local MCP"}</button>:view==="Capability intelligence"?<button className="button primary" onClick={analyzeCapabilities} disabled={busy}><Layers3 size={15}/>{busy?"Analyzing...":"Analyze capabilities"}</button>:view==="Runtime monitoring"?<button className="button primary" onClick={runMonitor} disabled={busy||runtimeMonitoring.monitorStatus.running}><Activity size={15}/>{busy||runtimeMonitoring.monitorStatus.running?"Monitoring...":"Run security scan"}</button>:<><button className="button secondary" onClick={reset} disabled={busy}><RefreshCw size={15}/> Reset demo</button><button className="button primary" onClick={()=>{setView("Blast radius");const n=graph.nodes.find(n=>n.id==="tool-fetch");if(n)select(n);}}><Play size={15}/> Run simulation</button></>}</div></div>
        {notice&&<div className="notice"><Activity size={15}/>{notice}<button onClick={()=>setNotice("")}>×</button></div>}
        <section className={"metrics "+(view==="Overview"?"":"hidden")}>
          <Metric icon={Bot} label="Connected agents" value={overview?.agents??"—"} sub="Across 3 teams" tone="violet"/>
          <Metric icon={Cable} label="MCP servers" value={overview?.mcpServers??"—"} sub="All connected" tone="teal"/>
          <Metric icon={Zap} label="Registered tools" value={overview?.tools??"—"} sub={(overview?.highRiskTools??0)+" high-risk tools"} tone="amber"/>
          <Metric icon={AlertTriangle} label="Failed findings" value={overview?.failedFindings??"—"} sub="Evidence-backed" tone="red"/><Metric icon={Database} label="Discovered MCP" value={overview?.discoveredMcpServers??0} sub="Local configs" tone="teal"/>
        </section>
        <div className={"section-row "+(["Agent inventory","Evidence","MCP discovery","Capability intelligence","Runtime monitoring"].includes(view)?"hidden":"")}><div><h2>Connected environment</h2><p>Live relationships stored in your embedded Relate graph.</p></div><div className="graph-legend"><span><i className="legend-dot violet"/> Agent</span><span><i className="legend-dot teal"/> MCP</span><span><i className="legend-dot amber"/> Tool</span><span><i className="legend-dot lilac"/> Capability</span><span><i className="legend-dot blue"/> Policy</span></div></div>
        <section className={"graph-layout "+(["Agent inventory","Evidence","MCP discovery","Capability intelligence","Runtime monitoring"].includes(view)?"hidden":"")}>
          <div className="graph-card"><div className="graph-toolbar"><div className="graph-title"><Network size={16}/> RELATIONSHIP MAP <span>{graph.nodes.length} NODES · {graph.edges.length} EDGES</span></div><label className="search-box"><Search size={14}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Find a node..."/></label></div>
            <div className="graph-canvas" style={{height:Math.max(610,graphLayout.height*0.7)+"px"}}><div className="graph-columns"><span>AGENTS / HOSTS</span><span>INFRASTRUCTURE</span><span>TOOLS</span><span>CAPABILITIES</span><span>CONTROLS</span></div>
              <svg className="edges" viewBox={"0 0 1180 "+graphLayout.height} preserveAspectRatio="none">{graph.edges.map((edge,i)=>{const a=graphLayout.positions[edge.source],b=graphLayout.positions[edge.target];if(!a||!b)return null;const active=impact&&(edge.source===selected?.id||edge.target===selected?.id||impact.affectedAgents?.some((x:any)=>x.id===edge.source||x.id===edge.target));return <line key={i} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} className={active?"edge highlighted":"edge"}/>;})}</svg>
              {visible.map(n=>{const p=graphLayout.positions[n.id];if(!p)return null;const Icon=meta[n.labels[0]]?.icon??Boxes;const affected=impact?.affectedAgents?.some((a:any)=>a.id===n.id);return <button key={n.id} className={"graph-node "+(selected?.id===n.id?"selected ":"")+(affected?"affected":"")} style={{left:(p[0]/11.8)+"%",top:(p[1]/graphLayout.height*100)+"%","--node-color":color(n)} as React.CSSProperties} onClick={()=>select(n)} title={n.id}><Icon size={14}/><span>{name(n)}</span>{n.properties.risk==="HIGH"&&<i/>}</button>;})}
              <div className="graph-hint">Select any node to inspect its connected context</div>
            </div>
          </div>
          <aside className="inspector"><div className="inspector-head"><div><span className="eyebrow">NODE INSPECTOR</span><h3>{selected?name(selected):"Select a node"}</h3></div><button className="icon-button" onClick={()=>{setSelected(null);setImpact(null);}}>×</button></div>
            {selected?<><div className="node-type" style={{color:color(selected)}}>{selected.labels[0]}</div><div className="property-list">{Object.entries(selected.properties).filter(([k])=>k!=="id"&&k!=="serverId").map(([k,v])=><div className="property" key={k}><span>{k.replace(/[A-Z]/g,m=>" "+m.toLowerCase())}</span><b>{String(v)}</b></div>)}</div>
              {selected.labels.includes("Tool")&&<div className="impact-panel"><div className="eyebrow">CONNECTED IMPACT</div><div className="impact-stat"><b>{impact?.affectedAgents?.length??0}</b><span>affected agents</span></div><div className="impact-list">{impact?.affectedAgents?.map((a:any)=><div key={a.id}><Bot size={14}/>{a.name}</div>)}</div><button className="button danger full" disabled={busy||selected.properties.compromised} onClick={()=>simulate(selected.id)}><ShieldAlert size={15}/>{selected.properties.compromised?"Compromise simulated":"Simulate compromise"}</button></div>}
              <div className="inspector-foot"><span>GRAPH ENTITY ID</span><code>{selected.id}</code></div></>:<div className="empty-inspector"><Network size={28}/><p>Choose an agent, server, tool, capability, policy or evidence node to inspect its relationships.</p></div>}
          </aside>
        </section>
        <section className={"discovery-panel "+(view==="MCP discovery"?"":"hidden")}>
          <div className="discovery-panel-head"><div><span className="eyebrow">LOCAL CONFIGURATION INVENTORY</span><h2>Discovered MCP servers</h2><p>Configured definitions found on this machine and selected workspaces.</p></div><span className="discovery-count">{discoveredServers.length} server definition(s) · {inspections.length} inspected</span></div>
          <div className="discovery-safety"><ShieldCheck size={16}/><span><b>Read-only inventory.</b> Scanning never starts a process. Inspecting a server performs protocol negotiation and read-only metadata calls; it never invokes tools. Credential values, command arguments, environment values and header values are not persisted.</span></div>
          {discoveryDiagnostics.length>0&&<div className="discovery-warnings">{discoveryDiagnostics.map((item,i)=><div key={i}><AlertTriangle size={14}/><span>{item.source} · {item.message}</span></div>)}</div>}
          {discoveredServers.length===0?<div className="discovery-empty"><Database size={28}/><b>No MCP configurations discovered yet</b><p>Run a scan to inspect the supported local configuration files. Add workspace roots through AGENT_TRELLIS_WORKSPACES when needed.</p></div>:<div className="discovery-list">{discoveredServers.map(server=>{const inspection=inspections.find(item=>item.serverId===server.id);return <article className="discovery-row" key={server.id}>
            <div className="discovery-main"><div><b>{server.name}</b><small>{server.hostName} · {server.source}</small></div><span className={"discovery-status "+(inspection?.result==="PASS"?"inspection-pass":inspection?.result==="FAIL"?"inspection-fail":"")}>{inspection?inspection.result+" · "+(inspection.protocolEra??"CONNECTED"):"CONFIGURED · NOT INSPECTED"}</span></div>
            <code className="discovery-endpoint">{server.endpoint??server.command??"Transport metadata only"}</code>
            <div className="discovery-tags"><span>{server.transport.toUpperCase()}</span><span>{server.configScope}</span><span>{server.argumentCount} argument(s) redacted</span><span>{server.environmentKeys.length} env key(s)</span><span>{server.headerNames.length} header name(s)</span>{server.credentialHints&&<span>Credential-like config</span>}</div>
            {inspection&&<div className="inspection-summary">
              <div className="inspection-meta"><span>Protocol: {inspection.protocolVersion??"unknown"} ({inspection.protocolEra??"unknown"})</span><span>Inspected: {new Date(inspection.inspectedAt).toLocaleString()}</span><span>Tools: {inspection.tools.length}</span></div>
              {inspection.errorSummary&&<div className="inspection-error">Connection/inspection error: {inspection.errorSummary}</div>}
              {inspection.serverInfoJson&&<div className="inspection-meta">Server: {inspection.serverInfoJson}</div>}
              {inspection.capabilityComparisonsJson&&<details className="inspection-details"><summary>Declared vs observed capabilities</summary><pre>{inspection.capabilityComparisonsJson}</pre></details>}
              {inspection.tools.length>0&&<details className="inspection-details"><summary>Tool schemas ({inspection.tools.length})</summary>{inspection.tools.map(tool=><details key={String(tool.name)}><summary>{String(tool.name)}{tool.description?" · "+String(tool.description):""}</summary><pre>{String(tool.inputSchemaJson??"{}")}</pre>{tool.outputSchemaJson?<pre>{String(tool.outputSchemaJson)}</pre>:null}</details>)}</details>}
            </div>}
            <div className="discovery-actions"><div className="discovery-path">{server.configPath}</div><button className="button secondary" disabled={busy} onClick={()=>inspectServer(server)}><Search size={14}/>{busy?"Inspecting...":inspection?"Reinspect":"Inspect server"}</button></div>
          </article>;})}</div>}
        </section>
        <section className={"capability-panel "+(view==="Capability intelligence"?"":"hidden")}>
          <div className="capability-summary">
            <div><span className="eyebrow">SCHEMA-DERIVED SECURITY MODEL</span><h2>Observed capability exposure</h2><p>Deterministic inferences from inspected tool metadata. Scores are triage signals, not proof of exploitability.</p></div>
            <div className="capability-summary-stats"><div><b>{capabilityIntelligence.summary.analyzedTools}/{capabilityIntelligence.summary.tools}</b><small>TOOLS ANALYZED</small></div><div><b>{capabilityIntelligence.summary.highRiskTools}</b><small>HIGH / CRITICAL</small></div><div><b>{capabilityIntelligence.summary.capabilities}</b><small>CAPABILITY TYPES</small></div><div><b>{capabilityIntelligence.summary.unassociatedServers}</b><small>UNASSOCIATED SERVERS</small></div></div>
          </div>
          <div className="capability-safety"><ShieldCheck size={16}/><span>Inference uses tool names, descriptions, input/output schema metadata and MCP annotations. Annotations are untrusted declarations, not enforced permissions. Agent links are created only when explicitly assigned here.</span></div>
          {capabilityIntelligence.servers.length===0?<div className="discovery-empty"><Layers3 size={28}/><b>No discovered MCP servers</b><p>Discover and inspect an MCP server first. Capability inference requires an inspected tool catalogue.</p></div>:<div className="capability-server-list">{capabilityIntelligence.servers.map(server=><article className="capability-server" key={server.id}>
            <div className="capability-server-head"><div><b>{server.name}</b><small>{server.hostName} · {server.transport.toUpperCase()}</small></div><div className={"exposure-score "+String(server.exposureLevel??"UNKNOWN").toLowerCase()}><b>{server.exposureScore??"—"}</b><small>{server.exposureLevel??"NOT ANALYZED"} EXPOSURE</small></div></div>
            <div className="capability-associations"><div className="association-title"><b>Associated agents</b><small>{server.agents.length?server.agents.length+" linked":"No agent association yet"}</small></div><div className="association-list">{server.agents.map((agent:any)=><span className="association-chip" key={agent.id}><Bot size={12}/>{agent.name}<small>{agent.associationSource==="user-confirmed"?"CONFIRMED":"EXISTING"}</small>{agent.associationSource==="user-confirmed"&&<button disabled={busy} title="Remove association" onClick={()=>removeServerAssociation(agent.id,server.id)}>×</button>}</span>)}</div><div className="association-form"><select value={associationSelections[server.id]??""} onChange={e=>setAssociationSelections(current=>({...current,[server.id]:e.target.value}))}><option value="">Select an agent to associate</option>{agents.map(agent=><option key={agent.id} value={agent.id}>{agent.name}</option>)}</select><button className="button secondary" disabled={busy||!associationSelections[server.id]||server.agents.some((agent:any)=>agent.id===associationSelections[server.id])} onClick={()=>associateServer(server.id)}>Associate agent</button></div></div>
            <div className="capability-tools-head"><b>Inspected tools</b><small>{server.tools.length} tool(s) · {server.analyzedToolCount??0} analyzed</small></div>
            {server.tools.length===0?<div className="capability-empty">Inspect this MCP server to retrieve its tool catalogue.</div>:<div className="capability-tool-list">{server.tools.map((tool:any)=><div className="capability-tool" key={tool.id}>
              <div className="capability-tool-head"><div><b>{tool.name}</b><small>{tool.permissionMode} · {tool.capabilityAnalysisVersion?"INFERRED":"NOT ANALYZED"}</small></div><div className={"tool-risk "+String(tool.riskLevel??"UNKNOWN").toLowerCase()}>{tool.riskScore??"—"} · {tool.riskLevel??"UNKNOWN"}</div></div>
              <div className="capability-chip-list">{(Array.isArray(tool.capabilities)?tool.capabilities:[]).map((cap:any)=><span className="capability-chip" key={cap.key}>{cap.name} · {Math.round((cap.confidence??0)*100)}%</span>)}</div>
              <div className="capability-tool-foot">{tool.analysisSummary??"Run capability analysis to classify this tool."}</div>
              {Array.isArray(tool.comparisons)&&tool.comparisons.some((comparison:any)=>comparison.status==="mismatch")&&<div className="capability-mismatch"><AlertTriangle size={13}/>{tool.comparisons.filter((comparison:any)=>comparison.status==="mismatch").map((comparison:any)=>comparison.property+" mismatch").join(" · ")}</div>}
              {Array.isArray(tool.comparisons)&&tool.comparisons.length>0&&<details className="inspection-details"><summary>Declared annotation vs observed signals</summary><pre>{JSON.stringify(tool.comparisons,null,2)}</pre></details>}
            </div>)}</div>}
          </article>)}</div>}
        </section>
        <section className={"capability-panel "+(view==="Runtime monitoring"?"":"hidden")}>
          <div className="capability-summary">
            <div><span className="eyebrow">CONTINUOUS SECURITY MONITOR</span><h2>Security monitoring</h2><p>Scheduled read-only MCP inspections, inferred permission changes, blast-radius history and separately reported execution events.</p></div>
            <div className="capability-summary-stats">
              <div><b>{runtimeMonitoring.summary.totalEvents??0}</b><small>RUNTIME EVENTS</small></div>
              <div><b>{runtimeMonitoring.summary.callsFailed??0}</b><small>FAILED CALLS</small></div>
              <div><b>{runtimeMonitoring.summary.callsOutcomeUnknown??0}</b><small>UNKNOWN OUTCOMES</small></div>
              <div><b>{runtimeMonitoring.summary.policyDenials??0}</b><small>POLICY DENIALS</small></div>
              <div><b>{runtimeMonitoring.summary.sideEffects??0}</b><small>ADAPTER-REPORTED EFFECTS</small></div>
              <div><b>{runtimeMonitoring.independentObservations.total??0}</b><small>INDEPENDENT HOST OBSERVATIONS</small></div>
            </div>
          </div>
          <div className="capability-safety"><ShieldCheck size={16}/><span>{runtimeMonitoring.monitorStatus.enabled?"Automatic monitor is enabled every "+Math.round(runtimeMonitoring.monitorStatus.intervalMs/60000)+" minute(s).":"Automatic monitor scheduling is disabled."} HTTP and SSE servers are reinspected automatically. Local stdio servers are {runtimeMonitoring.monitorStatus.includeStdio?"enabled by explicit configuration.":"skipped unless AGENT_TRELLIS_MONITOR_STDIO=true is configured."} This process compares exposed tool metadata; it does not invoke MCP tools. Runtime gateway coverage includes Streamable HTTP and legacy SSE; local stdio requires the separate opt-in sidecar. {runtimeMonitoring.telemetryConfigured?"HTTP/SSE runtime gateway is enabled.":"HTTP/SSE runtime gateway is disabled until AGENT_TRELLIS_RUNTIME_TOKEN is configured."} Independent host observation is limited to opt-in filesystem watching around local stdio servers; remote database, cloud, email and payment effects require those systems' audit feeds. Adapter-reported effect events remain claims from the adapter. Capability inferences remain heuristic; no policy enforcement is claimed.</span></div>
          <div className="capability-summary-stats monitor-metrics">
            <div><b>{runtimeMonitoring.drift.total}</b><small>SCHEMA DRIFT</small></div>
            <div><b>{runtimeMonitoring.capabilityDrift.total}</b><small>CAPABILITY DRIFT</small></div>
            <div><b>{runtimeMonitoring.capabilityDrift.permissionEscalations}</b><small>PERMISSION ESCALATIONS</small></div>
            <div><b>{runtimeMonitoring.blastRadius.total}</b><small>BLAST-RADIUS CHANGES</small></div>
          </div>
          <div className="monitor-run-status"><span>Last monitor run: {runtimeMonitoring.monitorRuns.latest?.completedAt?new Date(runtimeMonitoring.monitorRuns.latest.completedAt).toLocaleString():"Not run yet"}</span><span>{runtimeMonitoring.monitorStatus.running?"RUNNING":runtimeMonitoring.monitorRuns.latest?.result??"IDLE"}</span></div>
          <div className="runtime-monitoring-grid">
            <div className="runtime-monitoring-column">
              <div className="capability-tools-head"><b>Recent runtime events</b><small>{runtimeMonitoring.events.length} shown · {runtimeMonitoring.provenance.gatewayObserved} gateway-observed / {runtimeMonitoring.provenance.adapterReported} adapter-reported / {runtimeMonitoring.provenance.independentObserver} independent observer</small></div>
              {runtimeMonitoring.events.length===0?<div className="capability-empty">No runtime events yet. Route an agent's Streamable HTTP or legacy SSE MCP connection through /api/runtime/mcp/:serverId, use the opt-in stdio sidecar for local servers, or connect an execution adapter to POST /api/runtime/events.</div>:runtimeMonitoring.events.map((event:any)=><article className="runtime-event" key={event.id}>
                <div><b>{event.toolName}</b><small>{event.serverName} · {event.eventType} · {new Date(event.observedAt).toLocaleString()}</small><small className="runtime-event-detail">{event.sourceKind==="gateway_observed"?"Gateway observed protocol traffic":"Adapter-reported telemetry"}</small></div>
                <span className={"tool-risk "+String(event.severity??"INFO").toLowerCase()}>{event.severity}</span>
                {event.effect&&<small className="runtime-event-detail">Adapter-reported effect: {event.effect}</small>}
                {event.agentName&&<small className="runtime-event-detail">Agent: {event.agentName}</small>}
                {event.durationMs!==undefined&&<small className="runtime-event-detail">Duration: {event.durationMs} ms</small>}
              </article>)}
            </div>
            <div className="runtime-monitoring-column">
              <div className="capability-tools-head"><b>Independent host side effects</b><small>{runtimeMonitoring.independentObservations.total} observation(s)</small></div>
              {runtimeMonitoring.independentObservations.events.length===0?<div className="capability-empty">No independently observed host filesystem changes. Local stdio observation requires explicit filesystem-watch opt-in and configured watch roots.</div>:runtimeMonitoring.independentObservations.events.map((event:any)=><article className="runtime-event" key={event.id}>
                <div><b>{event.effect}</b><small>{event.serverName} · {new Date(event.observedAt).toLocaleString()}</small></div>
                <span className="tool-risk high">{event.eventCount} change(s)</span>
                <small className="runtime-event-detail">Observer: {event.observer} · Correlation: {event.correlation}</small>
                <small className="runtime-event-detail">{event.summary}</small>
              </article>)}
            </div>
            <div className="runtime-monitoring-column">
              <div className="capability-tools-head"><b>Schema drift history</b><small>{runtimeMonitoring.drift.total} detected change set(s)</small></div>
              {runtimeMonitoring.drift.events.length===0?<div className="capability-empty">No drift detected. Reinspect a server after its tool catalogue changes to compare it with the persisted baseline.</div>:runtimeMonitoring.drift.events.map((event:any)=><article className="runtime-event" key={event.id}>
                <div><b>{event.serverName}</b><small>{new Date(event.inspectedAt).toLocaleString()} · {event.changeCount} change(s)</small></div>
                <span className={"tool-risk "+String(event.severity??"MEDIUM").toLowerCase()}>{event.severity}</span>
                <details className="inspection-details"><summary>View detected changes</summary><pre>{event.changesJson}</pre></details>
              </article>)}
            </div>
            <div className="runtime-monitoring-column">
              <div className="capability-tools-head"><b>Capability and permission drift</b><small>{runtimeMonitoring.capabilityDrift.total} change(s) · {runtimeMonitoring.capabilityDrift.permissionEscalations} escalation(s)</small></div>
              {runtimeMonitoring.capabilityDrift.events.length===0?<div className="capability-empty">No inferred capability changes recorded.</div>:runtimeMonitoring.capabilityDrift.events.map((event:any)=><article className="runtime-event" key={event.id}>
                <div><b>{event.toolName??event.title}</b><small>{event.serverId} · {new Date(event.analyzedAt).toLocaleString()}</small></div>
                <span className={"tool-risk "+String(event.severity??"MEDIUM").toLowerCase()}>{event.result}</span>
                <small className="runtime-event-detail">Added: {(event.addedCapabilityKeys??[]).join(", ")||"none"} · Removed: {(event.removedCapabilityKeys??[]).join(", ")||"none"}</small>
                <small className="runtime-event-detail">{event.previousPermissionMode??"—"} → {event.currentPermissionMode??"—"} · {event.previousRiskLevel??"—"} → {event.currentRiskLevel??"—"}</small>
                <small className="runtime-event-detail">Heuristic comparison only; not proof of tool execution or exploitability.</small>
              </article>)}
            </div>
            <div className="runtime-monitoring-column">
              <div className="capability-tools-head"><b>Blast-radius changes</b><small>{runtimeMonitoring.blastRadius.total} event(s) · {runtimeMonitoring.blastRadius.expanded} expanded</small></div>
              {runtimeMonitoring.blastRadius.events.length===0?<div className="capability-empty">No blast-radius changes recorded yet.</div>:runtimeMonitoring.blastRadius.events.map((event:any)=><article className="runtime-event" key={event.id}>
                <div><b>{event.serverName}</b><small>{new Date(event.observedAt).toLocaleString()}</small></div>
                <span className={"tool-risk "+String(event.severity??"MEDIUM").toLowerCase()}>{event.result}</span>
                <small className="runtime-event-detail">Agents added: {(event.addedAgents??[]).join(", ")||"none"} · removed: {(event.removedAgents??[]).join(", ")||"none"}</small>
                <small className="runtime-event-detail">Capabilities added: {(event.addedCapabilities??[]).join(", ")||"none"} · removed: {(event.removedCapabilities??[]).join(", ")||"none"}</small>
                <details className="inspection-details"><summary>Before / after graph snapshot</summary><pre>{event.previousSnapshotJson}

→

{event.currentSnapshotJson}</pre></details>
              </article>)}
            </div>
          </div>
        </section>
        <div className={"bottom-grid "+(view==="Graph explorer"||view==="MCP discovery"||view==="Capability intelligence"||view==="Runtime monitoring"?"hidden":"")+((view==="Agent inventory"||view==="Evidence")?" single":"")}>
          <section className={"panel "+(view==="Evidence"?"hidden":"")}><div className="panel-heading"><div><h2>Agent inventory</h2><p>Registered autonomous systems</p></div><button className="text-button" onClick={()=>setView("Agent inventory")}>View all <ArrowUpRight size={14}/></button></div>
            {agents.map(a=><div className="agent-row" key={a.id}><div className="agent-icon"><Bot size={17}/></div><div className="agent-info"><b>{a.name}</b><small>{a.owner}</small></div><span className={"risk-badge "+a.risk.toLowerCase()}>{a.risk} RISK</span><span className="agent-status"><i/>{a.status}</span></div>)}
          </section>
          <section className={"panel "+(view==="Agent inventory"?"hidden":"")}><div className="panel-heading"><div><h2>Recent evidence</h2><p>Signals linked to graph entities</p></div><button className="text-button" onClick={()=>setView("Evidence")}>View all <ArrowUpRight size={14}/></button></div>
            {evidence.slice(0,4).map(e=><div className="evidence-row" key={e.id}><div className={"evidence-icon "+e.result.toLowerCase()}>{e.result==="FAIL"?<AlertTriangle size={15}/>:<FileCheck2 size={15}/>}</div><div className="evidence-info"><b>{e.title}</b><small>{e.source} · {e.age}</small></div><span className={"result "+e.result.toLowerCase()}>{e.result}</span></div>)}
          </section>
        </div>
        <footer><span>AGENTTRELLIS <i>·</i> GRAPH INTELLIGENCE FOR AGENT SECURITY</span><span><span className="pulse-dot"/> RELATE EMBEDDED DATABASE <b>·</b> LOCAL PERSISTENCE</span></footer>
      </div>
    </main>
  </div>;
}
function Metric({icon:Icon,label,value,sub,tone}:any){return <div className="metric-card"><div className={"metric-icon "+tone}><Icon size={18}/></div><div className="metric-label">{label}</div><div className="metric-value">{value}</div><div className="metric-sub">{sub}</div></div>;}
export default App;
