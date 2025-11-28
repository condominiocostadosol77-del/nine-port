import { createClient } from '@supabase/supabase-js';

// --- CONFIGURAÇÃO DO BANCO DE DADOS (SUPABASE) ---
// Para sincronizar entre dispositivos, crie um projeto em https://supabase.com
// e cole sua URL e CHAVE PÚBLICA (ANON KEY) abaixo.
// Se deixar vazio, o sistema continuará salvando apenas no navegador deste dispositivo.
const SUPABASE_URL = ''; 
const SUPABASE_KEY = '';

const USE_CLOUD = SUPABASE_URL.length > 10 && SUPABASE_KEY.length > 10;

let supabase: any = null;
if (USE_CLOUD) {
  try {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    console.log('Conectado ao Supabase (Nuvem)');
  } catch (e) {
    console.error('Erro ao conectar Supabase:', e);
  }
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// --- CLOUD CLIENT (SUPABASE) ---
class CloudEntityClient {
  private table: string;

  constructor(table: string) {
    this.table = table;
  }

  async list(sort?: string, limit?: number) {
    if (!supabase) return [];
    
    let query = supabase.from(this.table).select('*');
    
    if (sort) {
      const desc = sort.startsWith('-');
      const key = desc ? sort.substring(1) : sort;
      // Mapeamento simples de campos de data caso o nome no banco seja diferente,
      // mas vamos assumir que o banco segue a estrutura do JSON
      query = query.order(key === 'created_date' ? 'created_at' : key, { ascending: !desc });
    } else {
      query = query.order('created_at', { ascending: false });
    }

    if (limit) {
      query = query.limit(limit);
    }

    const { data, error } = await query;
    if (error) {
      console.error(`Erro ao listar ${this.table}:`, error);
      throw error;
    }
    
    // Normalizar ID se necessário (Supabase usa id numérico ou uuid, app usa string)
    return data.map((d: any) => ({ ...d, id: d.id.toString(), created_date: d.created_at }));
  }

  async create(data: any) {
    if (!supabase) return null;
    
    // Obter usuário atual da sessão local para log
    const sessionStr = localStorage.getItem('base44_session');
    const currentUser = sessionStr ? JSON.parse(sessionStr) : null;

    const payload = {
      ...data,
      registrado_por: currentUser ? currentUser.nome : 'Sistema',
      // Supabase gerencia created_at e id automaticamente se configurado,
      // mas enviamos dados extras como JSONB se a coluna não existir explicitamente
    };

    // Tentar inserir. Nota: As tabelas precisam existir no Supabase.
    // Se não existirem, este método falhará.
    const { data: created, error } = await supabase.from(this.table).insert(payload).select().single();
    
    if (error) {
      console.error(`Erro ao criar em ${this.table}:`, error);
      // Fallback silencioso ou erro? Vamos lançar erro para feedback.
      throw error;
    }
    return { ...created, id: created.id.toString(), created_date: created.created_at };
  }

  async update(id: string, data: any) {
    if (!supabase) return null;
    const { data: updated, error } = await supabase.from(this.table).update(data).eq('id', id).select().single();
    if (error) throw error;
    return { ...updated, id: updated.id.toString() };
  }

  async delete(id: string) {
    if (!supabase) return null;
    const { error } = await supabase.from(this.table).delete().eq('id', id);
    if (error) throw error;
    return { success: true };
  }
}

// --- LOCAL CLIENT (LOCALSTORAGE) ---
class LocalEntityClient {
  private entityName: string;

  constructor(entityName: string) {
    this.entityName = entityName;
  }

  private getStorageKey() {
    return `base44_${this.entityName}`;
  }

  private getData(): any[] {
    try {
      const data = localStorage.getItem(this.getStorageKey());
      return data ? JSON.parse(data) : [];
    } catch (e) {
      return [];
    }
  }

  private saveData(data: any[]) {
    try {
      localStorage.setItem(this.getStorageKey(), JSON.stringify(data));
    } catch (e) {
      console.error("Failed to save data", e);
    }
  }

  private getCurrentUser(): { id: string, nome: string } | null {
    try {
      const session = localStorage.getItem('base44_session');
      return session ? JSON.parse(session) : null;
    } catch (e) {
      return null;
    }
  }

  async list(sort?: string, limit?: number) {
    await delay(300);
    let data = this.getData();
    
    // Auto-fix IDs
    let modified = false;
    data = data.map(item => {
      if (!item.id) {
        modified = true;
        return { ...item, id: Math.random().toString(36).substring(2, 11) };
      }
      return item;
    });
    if (modified) {
      this.saveData(data);
    }

    if (sort) {
      const desc = sort.startsWith('-');
      const key = desc ? sort.substring(1) : sort;
      data.sort((a, b) => {
        const valA = a[key] || '';
        const valB = b[key] || '';
        if (valA < valB) return desc ? 1 : -1;
        if (valA > valB) return desc ? -1 : 1;
        return 0;
      });
    }
    if (limit && limit > 0) {
      data = data.slice(0, limit);
    }
    return data;
  }

  async create(data: any) {
    await delay(300);
    const list = this.getData();
    const currentUser = this.getCurrentUser();

    const newItem = { 
      ...data, 
      id: Math.random().toString(36).substring(2, 11),
      created_date: new Date().toISOString(),
      registrado_por: currentUser ? currentUser.nome : 'Sistema',
      registrado_por_id: currentUser ? currentUser.id : null
    };
    list.unshift(newItem);
    this.saveData(list);
    return newItem;
  }

  async update(id: string, data: any) {
    await delay(300);
    const list = this.getData();
    const index = list.findIndex(item => item.id === id);
    if (index !== -1) {
      list[index] = { ...list[index], ...data };
      this.saveData(list);
      return list[index];
    }
    throw new Error('Entity not found');
  }

  async delete(id: string) {
    await delay(300);
    const list = this.getData();
    const newList = list.filter(item => item.id !== id);
    this.saveData(newList);
    return { success: true };
  }
}

// Factory para escolher o cliente correto
const getClient = (entityName: string) => {
  if (USE_CLOUD) {
    // Mapeamento de nomes de tabelas para o Supabase (recomendado minúsculo)
    // Se as tabelas não existirem, o usuário precisará criar no painel do Supabase
    // com colunas JSONB para facilitar ou colunas estruturadas.
    // Para simplificar, assumimos que o usuário criou tabelas com os nomes abaixo:
    const tableMap: any = {
      'Encomenda': 'encomendas',
      'Ocorrencia': 'ocorrencias',
      'Funcionario': 'funcionarios',
      'RegistroPonto': 'pontos',
      'Morador': 'moradores',
      'ItemRecebido': 'itens',
      'Entregador': 'entregadores',
      'VisitaEntregador': 'visitas',
      'Empresa': 'empresas',
      'MaterialEmprestado': 'materiais',
      'Visitante': 'visitantes'
    };
    return new CloudEntityClient(tableMap[entityName] || entityName.toLowerCase());
  }
  return new LocalEntityClient(entityName);
};

export const base44 = {
  auth: {
    getSession: () => {
      try {
        const session = localStorage.getItem('base44_session');
        return session ? JSON.parse(session) : null;
      } catch (e) {
        return null;
      }
    },
    login: async (funcionarioId: string, funcionarioNome: string) => {
      await delay(200);
      const session = {
        id: funcionarioId,
        nome: funcionarioNome,
        inicio_turno: new Date().toISOString()
      };
      localStorage.setItem('base44_session', JSON.stringify(session));
      return session;
    },
    logout: async () => {
      await delay(200);
      localStorage.removeItem('base44_session');
    },
    me: async () => {
      await delay(100);
      const session = localStorage.getItem('base44_session');
      if (session) {
        const s = JSON.parse(session);
        return { full_name: s.nome, email: 'Operador Ativo' };
      }
      return null;
    }
  },
  integrations: {
    Core: {
      UploadFile: async ({ file }: { file: File }) => {
        await delay(1000);
        // Em modo Cloud real, faríamos upload para Supabase Storage.
        // Aqui mantemos o blob local para compatibilidade imediata.
        return { file_url: URL.createObjectURL(file) };
      }
    }
  },
  entities: {
    Encomenda: getClient('Encomenda'),
    Ocorrencia: getClient('Ocorrencia'),
    Funcionario: getClient('Funcionario'),
    RegistroPonto: getClient('RegistroPonto'),
    Morador: getClient('Morador'),
    ItemRecebido: getClient('ItemRecebido'),
    Entregador: getClient('Entregador'),
    VisitaEntregador: getClient('VisitaEntregador'),
    Empresa: getClient('Empresa'),
    MaterialEmprestado: getClient('MaterialEmprestado'),
    Visitante: getClient('Visitante')
  }
};