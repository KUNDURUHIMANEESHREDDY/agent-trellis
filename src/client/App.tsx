import { useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, ArrowUpRight, Bot, Boxes, Cable, ChevronDown, CircleHelp, Command, Database, FileCheck2, Gauge, GitBranch, Layers3, Network, Play, RefreshCw, Search, ShieldAlert, ShieldCheck, Sparkles, TerminalSquare, Zap } from "lucide-react";

type NodeItem = { id: string; labels: string[]; properties: Record<string, any> };
type GraphData = { nodes: NodeItem[]; edges: { source: string; target: string; type: string }[] };
type Overview = { agents: number; mcpServers: number; discoveredMcpServers: number; tools: number; capabilities: number; policies: number; evidence: number; failedFindings: number; highRiskTools: number };
type DiscoveredMcpServer = { id: string; name: string; hostName: string; hostSource: string; source: string; configPath: string; configScope: string; transport: string; command?: string; endpoint?: string; argumentCount: number; environmentKeys: string[]; headerNames: string[]; credentialHints: boolean };
type MCPInspectionView = { id: string; serverId: string; serverName: string; result: string; severity: string; inspectedAt: string; transport: string; protocolEra: string; protocolVersion: string; serverInfoJson?: string; instructions?: string; declaredCapabilitiesJson?: string; observedCapabilitiesJson?: string; capabilityComparisonsJson?: string; errorSummary?: string; tools: Array<Record<string, unknown>> };
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
  const [selected,setSelected]=useState<NodeItem|null>(null),[impact,setImpact]=useState<any>(null),[busy,setBusy]=useState(false);
  const [notice,setNotice]=useState(""),[view,setView]=useState("Overview"),[query,setQuery]=useState("");
  const refresh=async()=>{const[o,g,a,e,d,i]=await Promise.all([api<Overview>("/api/overview"),api<GraphData>("/api/graph"),api<any[]>("/api/agents"),api<any[]>("/api/evidence"),api<DiscoveredMcpServer[]>("/api/discovery/mcp"),api<MCPInspectionView[]>("/api/inspection/mcp")]);setOverview(o);setGraph(g);setAgents(a);setEvidence(e);setDiscoveredServers(d);setInspections(i);if(selected)setSelected(g.nodes.find(n=>n.id===selected.id)??null);};
  const discover=async()=>{setBusy(true);try{const r=await api<{scannedConfigFiles:number;discoveredServers:number;diagnostics:{source:string;configPath:string;message:string}[];servers:DiscoveredMcpServer[]}>("/api/discovery/mcp",{method:"POST"});setDiscoveredServers(r.servers);setDiscoveryDiagnostics(r.diagnostics);setNotice("Read "+r.scannedConfigFiles+" local configuration file(s) · discovered "+r.discoveredServers+" MCP server definition(s) · no processes started.");await refresh();}catch(e){setNotice(e instanceof Error?e.message:"MCP discovery failed");}finally{setBusy(false);}};
  const inspectServer=async(server:DiscoveredMcpServer)=>{const approveStdio=server.transport==="stdio";setBusy(true);try{if(approveStdio){const preview=await api<{command:string;args:string[];cwd:string;environmentKeys:string[]}>("/api/inspection/mcp/"+encodeURIComponent(server.id)+"/approval-preview");const invocation=[preview.command,...preview.args].map(value=>JSON.stringify(value)).join(" ");const approved=window.confirm("This inspection will execute a local process. Review the command first:\n\n"+invocation+"\n\nWorking directory: "+preview.cwd+"\nEnvironment variable names: "+(preview.environmentKeys.join(", ")||"none")+"\nSensitive-looking values are redacted. Environment values are not displayed.\n\nProtocol negotiation may start a short-lived probe process before the inspection process. No MCP tools will be invoked. Continue?");if(!approved)return;}const result=await api<{result:string;protocolEra?:string;protocolVersion?:string;toolsCount:number;errorSummary?:string}>("/api/inspection/mcp/"+encodeURIComponent(server.id),{method:"POST",body:JSON.stringify({approveStdio})});setNotice(server.name+" · "+result.result+" · "+result.toolsCount+" tool(s) inspected"+(result.errorSummary?" · "+result.errorSummary:""));await refresh();}catch(e){setNotice(e instanceof Error?e.message:"MCP inspection failed");}finally{setBusy(false);}};
  useEffect(()=>{refresh().catch(e=>setNotice(e.message));},[]);
  const visible=useMemo(()=>graph.nodes.filter(n=>[n.properties.name,n.properties.title,n.properties.id,n.labels[0]].join(" ").toLowerCase().includes(query.toLowerCase())),[graph.nodes,query]);
  const graphLayout=useMemo(()=>{const map:Record<string,[number,number]>={...positions};const hosts=graph.nodes.filter(n=>n.labels.includes("MCPHost")).sort((a,b)=>String(a.properties.name).localeCompare(String(b.properties.name)));const servers=graph.nodes.filter(n=>n.labels.includes("MCPServer")&&n.properties.discovered===true).sort((a,b)=>String(a.properties.name).localeCompare(String(b.properties.name)));const discoveredTools=graph.nodes.filter(n=>n.labels.includes("Tool")&&n.properties.mcpDiscovered===true).sort((a,b)=>String(a.properties.name).localeCompare(String(b.properties.name)));const rows=Math.max(hosts.length,servers.length,discoveredTools.length);hosts.forEach((n,i)=>{map[n.id]=[112,880+i*92];});servers.forEach((n,i)=>{map[n.id]=[340,880+i*92];});discoveredTools.forEach((n,i)=>{map[n.id]=[570,880+i*92];});return{positions:map,height:Math.max(880,880+rows*92)};},[graph.nodes]);
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
      {([["Overview",Gauge],["Graph explorer",Network],["Agent inventory",Bot],["Evidence",FileCheck2],["Blast radius",ShieldAlert],["MCP discovery",Database]] as const).map(([label,Icon])=><button key={label} className={"nav-item "+(view===label?"active":"")} onClick={()=>setView(label)}><Icon size={17}/>{label}{label==="Evidence"&&<span className="nav-count">{evidence.length}</span>}</button>)}
      <div className="nav-label nav-spaced">SYSTEM</div>
      <button className="nav-item" onClick={()=>setNotice("Relate embedded graph · persistent local store")}><Database size={17}/>Graph database</button>
      <button className="nav-item" onClick={()=>setNotice("API status: healthy · /api/health")}><TerminalSquare size={17}/>API & integrations</button>
      <div className="sidebar-bottom"><div className="relate-chip"><span className="pulse-dot"/> RELATE CONNECTED <span>●</span></div><div className="user-row"><div className="avatar">R</div><div><b>Workspace owner</b><small>Administrator</small></div><CircleHelp size={17}/></div></div>
    </aside>
    <main className="main">
      <header className="topbar"><div className="breadcrumbs">Workspace <span>/</span> {view}</div><div className="top-actions"><div className="status-pill"><span className="pulse-dot"/> All systems operational</div><button className="icon-button" title="Refresh" onClick={()=>refresh()}><RefreshCw size={16}/></button><button className="icon-button" title="Command menu"><Command size={16}/></button><div className="top-avatar">R</div></div></header>
      <div className="content">
        <div className="page-heading"><div><div className="eyebrow"><Sparkles size={13}/> CONNECTED SECURITY CONTEXT</div><h1>{view==="Overview"?"Agent security overview":view}</h1><p>See how agents, tools, permissions and evidence connect across your environment.</p></div><div className="heading-actions">{view==="MCP discovery"?<button className="button primary" onClick={discover} disabled={busy}><Search size={15}/>{busy?"Scanning...":"Discover local MCP"}</button>:<><button className="button secondary" onClick={reset} disabled={busy}><RefreshCw size={15}/> Reset demo</button><button className="button primary" onClick={()=>{setView("Blast radius");const n=graph.nodes.find(n=>n.id==="tool-fetch");if(n)select(n);}}><Play size={15}/> Run simulation</button></>}</div></div>
        {notice&&<div className="notice"><Activity size={15}/>{notice}<button onClick={()=>setNotice("")}>×</button></div>}
        <section className={"metrics "+(view==="Overview"?"":"hidden")}>
          <Metric icon={Bot} label="Connected agents" value={overview?.agents??"—"} sub="Across 3 teams" tone="violet"/>
          <Metric icon={Cable} label="MCP servers" value={overview?.mcpServers??"—"} sub="All connected" tone="teal"/>
          <Metric icon={Zap} label="Registered tools" value={overview?.tools??"—"} sub={(overview?.highRiskTools??0)+" high-risk tools"} tone="amber"/>
          <Metric icon={AlertTriangle} label="Failed findings" value={overview?.failedFindings??"—"} sub="Evidence-backed" tone="red"/><Metric icon={Database} label="Discovered MCP" value={overview?.discoveredMcpServers??0} sub="Local configs" tone="teal"/>
        </section>
        <div className={"section-row "+(["Agent inventory","Evidence","MCP discovery"].includes(view)?"hidden":"")}><div><h2>Connected environment</h2><p>Live relationships stored in your embedded Relate graph.</p></div><div className="graph-legend"><span><i className="legend-dot violet"/> Agent</span><span><i className="legend-dot teal"/> MCP</span><span><i className="legend-dot amber"/> Tool</span><span><i className="legend-dot lilac"/> Capability</span><span><i className="legend-dot blue"/> Policy</span></div></div>
        <section className={"graph-layout "+(["Agent inventory","Evidence","MCP discovery"].includes(view)?"hidden":"")}>
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
        <div className={"bottom-grid "+(view==="Graph explorer"||view==="MCP discovery"?"hidden":"")+((view==="Agent inventory"||view==="Evidence")?" single":"")}>
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
