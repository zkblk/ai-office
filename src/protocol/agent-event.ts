export type AgentStatus='arriving'|'working'|'waiting'|'done';
export type AgentEventType='agent.started'|'agent.working'|'agent.waiting'|'agent.finished'|'usage.updated'|'skill.used';
export type AgentEvent={type:AgentEventType;agentId:string;at:number;provider?:string;model?:string;task?:string;tokens?:number;skill?:string};
export const mockEvents:AgentEvent[]=[
 {type:'agent.started',agentId:'ux',at:0,provider:'Codex',model:'GPT-5.6',task:'Carpen · Customer flow'},
 {type:'agent.working',agentId:'research',at:1600,provider:'Claude Code',model:'Claude',task:'Berg · HMI research'},
 {type:'agent.waiting',agentId:'ui',at:4200,provider:'Codex',model:'GPT-5.6',task:'AI Office · UI shell'},
 {type:'skill.used',agentId:'ux',at:6500,skill:'UX Designer'},
 {type:'usage.updated',agentId:'ux',at:8200,tokens:38400},
];