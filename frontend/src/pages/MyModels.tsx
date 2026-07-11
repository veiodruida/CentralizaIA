import { useState, useEffect, useMemo } from 'react';
import { io } from 'socket.io-client';
import { Search, RefreshCw, FileText, Play, Terminal, Box, ArrowLeft, Zap, ChevronDown, Edit3, Trash2, FolderOpen, HardDrive, Info, ExternalLink } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

const PAGE_VARIANTS = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.6, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] } },
  exit: { opacity: 0, y: -10, transition: { duration: 0.3 } }
};
import HelpTooltip from '../components/HelpTooltip';
import { useToast } from '../components/Toast';
import DeleteModal, { type ModelItem } from '../components/DeleteModal';
import { useApp } from '../context/AppContext';

interface Model {
  name: string;
  path: string;
  size: number;
  isSymlink: boolean;
  targetPath?: string;
  finalModelName: string;
  source: string;
  ollamaTag?: string;
  repoId?: string;
  extension?: string;
  description?: string;
  centralPath?: string;
}

const CONTAINER_VARIANTS = {
  hidden: { opacity: 0 },
  visible: { 
    opacity: 1,
    transition: { staggerChildren: 0.05 }
  }
};

const ITEM_VARIANTS = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] } }
};

export default function MyModels() {
  const { t } = useApp();
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [viewingModel, setViewingModel] = useState<Model | null>(null);
  const [description, setDescription] = useState('');
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    'Ollama': true,
    'ComfyUI': true,
    'LM Studio / Hugging Face': true,
  });
  const [sectionOrder, setSectionOrder] = useState<string[]>(['Ollama', 'ComfyUI', 'LM Studio / Hugging Face', 'Standalone']);
  const [deleteModalData, setDeleteModalData] = useState<{ isOpen: boolean; models: ModelItem[]; initialAction?: 'delete' | 'decentralize' | 'centralize' | null }>({ isOpen: false, models: [], initialAction: null });
  const { showToast } = useToast();

  const fetchModels = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/models');
      const data = await res.json();
      const uniqueModels = data.filter((m: Model, index: number, self: Model[]) => 
        index === self.findIndex((t) => t.path === m.path)
      );
      setModels(uniqueModels);
    } catch (err) { 
      console.error('Backend unreachable.'); 
      showToast('Backend connection failed', 'error');
    }
    finally { setLoading(false); }
  };

  useEffect(() => { 
    fetchModels(); 
    const socket = io();
    socket.on('models-updated', () => fetchModels());
    fetch('/api/config').then(res => res.json()).then(data => {
      if (data.sectionOrder) setSectionOrder(data.sectionOrder);
    });
    return () => { socket.disconnect(); };
  }, []);

  useEffect(() => {
    if (viewingModel) {
      setDescription(t('loading'));
      fetch(`/api/model-readme?repoId=${viewingModel.repoId || ''}&localPath=${encodeURIComponent(viewingModel.path)}`)
        .then(res => res.text())
        .then(data => setDescription(data));
    }
  }, [viewingModel, t]);

  const handleLaunch = async (model: Model, type: string, extraParams: any = {}) => {
    try {
      const res = await fetch('/api/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, modelPath: model.path, modelName: model.name, ollamaTag: model.ollamaTag, params: extraParams })
      });
      const data = await res.json();
      if (data.error) showToast(data.error, 'error');
      else showToast(data.message, 'success');
    } catch (e) { showToast(t('error'), 'error'); }
  };

  const handleOpenFolder = (path: string) => {
    fetch('/api/open-folder', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({folderPath: path})});
  };

  const handleCentralize = async (model: Model) => {
    try {
      const res = await fetch('/api/centralize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelPath: model.path, finalModelName: model.finalModelName || model.name })
      });
      if (res.ok) { showToast(t('central_centralized'), 'success'); fetchModels(); }
    } catch (err) { showToast(t('error'), 'error'); }
  };

  const handleRename = async (model: Model) => {
    const newName = prompt(t('name'), model.name.split('.')[0]);
    if (!newName) return;
    try {
      const res = await fetch('/api/models/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPath: model.path, newName })
      });
      if (res.ok) { showToast(t('settings_saved'), 'success'); fetchModels(); setViewingModel(null); }
      else { const data = await res.json(); showToast(data.error || t('error'), 'error'); }
    } catch (e) { showToast(t('error'), 'error'); }
  };

  const handleDelete = async (model: Model) => {
    setDeleteModalData({ isOpen: true, models: [model], initialAction: model.isSymlink ? 'decentralize' : 'delete' });
  };

  const handleModalConfirm = async (action: 'delete' | 'decentralize' | 'centralize') => {
    const targetModels = deleteModalData.models;
    if (targetModels.length === 0) return;
    for (const m of targetModels) {
      try {
        if (action === 'delete') await fetch('/api/models', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modelPath: m.path, ollamaTag: m.ollamaTag }) });
        else if (action === 'centralize') await fetch('/api/centralize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modelPath: m.path, finalModelName: m.finalModelName || m.name }) });
        else if (action === 'decentralize') await fetch('/api/models', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ centralPath: m.centralPath }) });
      } catch (e) { console.error(e); }
    }
    showToast(t('settings_saved'), 'success');
    setDeleteModalData({ ...deleteModalData, isOpen: false });
    fetchModels();
  };

  const groupedModels = useMemo(() => {
    const filtered = models.filter(m => m.name.toLowerCase().includes(search.toLowerCase()) || m.source.toLowerCase().includes(search.toLowerCase()));
    const groups: Record<string, Model[]> = {};
    filtered.forEach(m => { if (!groups[m.source]) groups[m.source] = []; groups[m.source].push(m); });
    return groups;
  }, [models, search]);

  const formatSize = (bytes: number) => (bytes / (1024 ** 3)).toFixed(2) + ' GB';

  if (viewingModel) {
    return (
      <motion.div 
        initial={{ opacity: 0, x: 20 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: -20 }}
        className="p-4 sm:p-6 md:p-12 lg:p-16 max-w-7xl mx-auto pb-20"
      >
        <button onClick={() => setViewingModel(null)} className="flex items-center gap-3 text-[var(--text-secondary)] hover:text-blue-500 mb-6 md:mb-10 transition-all font-black text-xs uppercase tracking-[0.2em] group">
          <ArrowLeft size={18} className="group-hover:-translate-x-2 transition-transform" /> {t('close')}
        </button>

        <div className="card-premium relative overflow-hidden backdrop-blur-3xl p-4 sm:p-6 md:p-8 lg:p-16">
          <div className="absolute top-0 right-0 w-96 h-96 bg-blue-600/5 blur-[120px] rounded-full -mr-20 -mt-20" />
          
          <header className="border-b border-[var(--border)] pb-12 mb-12 flex justify-between items-start flex-wrap gap-10">
             <div className="space-y-6 min-w-0 flex-1">
                <div className="flex items-center gap-4">
                  <h2 className="text-2xl sm:text-3xl md:text-4xl xl:text-6xl font-black text-[var(--text-primary)] tracking-tighter leading-none uppercase break-words">{viewingModel.name}</h2>
                  <HelpTooltip text="Model details and management" />
                </div>
                <div className="flex gap-3 flex-wrap">
                   <span className="bg-blue-500/10 text-blue-500 px-5 py-2 rounded-2xl text-xs font-black border border-blue-500/20 uppercase tracking-widest">{viewingModel.source}</span>
                   <span className="bg-emerald-500/10 text-emerald-500 px-5 py-2 rounded-2xl text-xs font-black border border-emerald-500/20 uppercase tracking-widest">{viewingModel.extension || 'GGUF'}</span>
                   <span className="bg-[var(--bg-input)] px-5 py-2 rounded-2xl text-xs font-black text-[var(--text-secondary)] border border-[var(--border)] uppercase tracking-widest">{formatSize(viewingModel.size)}</span>
                </div>
             </div>
             <div className="flex gap-4 w-full md:w-auto">
                 {viewingModel.source !== 'ComfyUI' ? (
                   <button onClick={() => handleLaunch(viewingModel, viewingModel.source.toLowerCase())} className="btn-premium flex-1 md:flex-none bg-[var(--text-primary)] text-[var(--bg-base)] hover:bg-blue-600 hover:text-white flex items-center justify-center gap-4">
                      <Play size={18} /> {t('dash_status')}
                   </button>
                 ) : (
                   <div className="px-8 py-5 bg-[var(--bg-input)] border border-[var(--border)] rounded-2xl text-[var(--text-muted)] text-xs font-black uppercase tracking-widest flex items-center gap-3">
                      <Info size={16} /> Passive Asset
                   </div>
                 )}
                <button onClick={() => handleOpenFolder(viewingModel.path)} className="bg-[var(--bg-input)] border border-[var(--border)] hover:bg-[var(--border)] text-[var(--text-primary)] p-5 rounded-2xl transition-all shadow-xl active:scale-95">
                   <FolderOpen size={24} />
                </button>
             </div>
          </header>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 md:gap-10 lg:gap-16">
             <div className="lg:col-span-2 space-y-12">
                <div>
                   <h3 className="text-[var(--text-muted)] font-black text-[11px] uppercase tracking-[0.5em] mb-8 flex items-center gap-4">
                      <FileText size={18} className="text-blue-500" /> {t('hub_details_desc')}
                   </h3>
                   <div className="bg-[var(--bg-input)]/50 p-5 sm:p-7 md:p-10 rounded-[1.5rem] md:rounded-[3rem] border border-[var(--border)] max-h-[600px] overflow-y-auto custom-scrollbar">
                      <pre className="whitespace-pre-wrap font-sans text-base text-[var(--text-secondary)] leading-relaxed font-medium">{description}</pre>
                   </div>
                </div>
             </div>

             <div className="space-y-12">
                <div className="bg-[var(--bg-input)]/50 p-5 sm:p-7 md:p-10 rounded-[1.5rem] md:rounded-[3rem] border border-[var(--border)] shadow-xl">
                   <h4 className="text-[11px] font-black text-[var(--text-muted)] uppercase tracking-widest mb-8 flex items-center gap-3">
                      <Info size={16} className="text-purple-500" /> Metadata
                   </h4>
                   <div className="space-y-6">
                      <div className="flex justify-between items-center border-b border-[var(--border)]/50 pb-6">
                         <span className="text-[11px] font-black text-[var(--text-muted)] uppercase tracking-widest">{t('size')}</span>
                         <span className="text-xl font-black text-[var(--text-primary)] tracking-tighter">{formatSize(viewingModel.size)}</span>
                      </div>
                      <div className="flex justify-between items-center border-b border-[var(--border)]/50 pb-6">
                         <span className="text-[11px] font-black text-[var(--text-muted)] uppercase tracking-widest">Storage Status</span>
                         <span className={`text-xs font-black uppercase tracking-widest ${viewingModel.isSymlink ? 'text-emerald-500' : 'text-amber-500'}`}>{viewingModel.isSymlink ? t('central_centralized') : 'Standalone'}</span>
                      </div>
                   </div>
                   {!viewingModel.isSymlink && (
                      <button onClick={() => handleCentralize(viewingModel)} className="w-full bg-blue-600 hover:bg-blue-500 text-white font-black text-xs uppercase tracking-[0.2em] py-5 rounded-2xl mt-10 transition-all flex items-center justify-center gap-4 shadow-xl shadow-blue-600/30">
                         <Zap size={20} /> {t('central_centralizeBtn')}
                      </button>
                   )}
                </div>

                <div className="bg-red-500/5 p-5 sm:p-7 md:p-10 rounded-[1.5rem] md:rounded-[3rem] border border-red-500/10 shadow-xl">
                   <h4 className="text-[11px] font-black text-red-500/70 uppercase tracking-widest mb-8 flex items-center gap-3">
                      <Terminal size={16} /> Danger Zone
                   </h4>
                   <div className="flex flex-col gap-4">
                      <button onClick={() => handleRename(viewingModel)} className="w-full bg-[var(--bg-surface)] hover:bg-[var(--border)] text-[var(--text-primary)] font-black py-5 rounded-2xl transition-all flex items-center justify-center gap-4 text-xs uppercase tracking-[0.2em] border border-[var(--border)] shadow-sm">
                         <Edit3 size={18} /> {t('save')}
                      </button>
                      <button onClick={() => handleDelete(viewingModel)} className="w-full bg-red-600 hover:bg-red-500 text-white font-black py-5 rounded-2xl transition-all flex items-center justify-center gap-4 text-xs uppercase tracking-[0.2em] shadow-xl shadow-red-600/20">
                         <Trash2 size={18} /> {t('delete')}
                      </button>
                   </div>
                </div>
             </div>
          </div>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div 
      variants={PAGE_VARIANTS}
      initial="initial"
      animate="animate"
      exit="exit"
      className="p-4 sm:p-6 md:p-12 lg:p-16 max-w-[100rem] mx-auto pb-20"
    >
      <div className="flex flex-col lg:flex-row justify-between items-stretch lg:items-end mb-8 md:mb-16 gap-6 md:gap-8">
        <div className="space-y-4">
          <h2 className="text-3xl md:text-4xl xl:text-5xl font-black text-[var(--text-primary)] tracking-tighter leading-none flex items-center gap-4 md:gap-6 uppercase break-words">
            {t('models_title')}
            <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
          </h2>
          <p className="text-[var(--text-secondary)] text-lg md:text-2xl font-medium opacity-80 max-w-xl leading-relaxed">
            {t('models_subtitle')}
          </p>
        </div>
        <div className="flex gap-5 flex-wrap">
          <div className="relative group flex-1 md:flex-none">
             <Search size={22} className="absolute left-6 top-1/2 -translate-y-1/2 text-[var(--text-muted)] group-focus-within:text-blue-500 transition-colors" />
             <input 
              type="text" 
              placeholder={t('models_search')} 
              value={search} 
              onChange={(e) => setSearch(e.target.value)} 
              className="w-full md:w-60 xl:w-96 bg-[var(--bg-surface)] border border-[var(--border)] rounded-[2rem] py-3 md:py-5 pl-14 md:pl-16 pr-6 md:pr-8 text-sm md:text-base focus:outline-none focus:ring-4 focus:ring-blue-600/10 text-[var(--text-primary)] shadow-xl transition-all font-medium" 
             />
          </div>
          <button onClick={fetchModels} className="bg-[var(--bg-surface)] hover:bg-[var(--bg-input)] text-[var(--text-primary)] p-5 rounded-2xl border border-[var(--border)] transition-all shadow-xl active:scale-95">
            <RefreshCw size={24} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      <AnimatePresence mode="wait">
        {loading ? (
          <motion.div 
            key="loading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex flex-col items-center justify-center py-40"
          >
            <div className="w-16 h-16 border-4 border-blue-500/20 border-t-blue-500 rounded-full animate-spin mb-6" />
            <span className="text-xs font-black uppercase tracking-widest text-[var(--text-muted)]">Indexing Library...</span>
          </motion.div>
        ) : models.length === 0 ? (
          <motion.div 
            key="empty"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="flex flex-col items-center justify-center py-40 text-center bg-[var(--bg-surface)]/50 rounded-[4rem] border border-[var(--border)] shadow-premium relative overflow-hidden"
          >
            <div className="w-32 h-32 rounded-[2.5rem] bg-[var(--bg-input)] border border-[var(--border)] flex items-center justify-center mb-10 shadow-xl">
              <HardDrive size={56} className="text-[var(--text-muted)] opacity-30" />
            </div>
            <h3 className="text-[var(--text-primary)] font-black text-4xl mb-4 tracking-tighter uppercase">{t('models_noModels')}</h3>
            <p className="text-[var(--text-secondary)] max-w-md text-xl font-medium opacity-80 leading-relaxed">{t('models_noModelsDesc')}</p>
          </motion.div>
        ) : (
          <div className="space-y-12">
            {sectionOrder.map(source => {
              const items = groupedModels[source] || [];
              if (items.length === 0) return null;
              const isExpanded = expandedSections[source] !== false;
              return (
                <motion.section 
                  key={source} 
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="bg-[var(--bg-surface)]/80 border border-[var(--border)] rounded-[2rem] sm:rounded-[3rem] overflow-hidden shadow-premium backdrop-blur-3xl group"
                >
                  <header 
                    className="flex items-center justify-between p-4 sm:p-6 md:p-8 lg:p-12 cursor-pointer hover:bg-blue-600/5 transition-all"
                    onClick={() => setExpandedSections(prev => ({ ...prev, [source]: !isExpanded }))}
                  >
                     <div className="flex items-center gap-10">
                        <div className={`w-20 h-20 rounded-[2rem] flex items-center justify-center text-white shadow-2xl transition-all duration-700 ${isExpanded ? 'scale-110 rotate-3 shadow-blue-500/40' : 'scale-90 opacity-40 grayscale'} ${source === 'Ollama' ? 'bg-gradient-to-br from-blue-600 to-blue-400' : source === 'ComfyUI' ? 'bg-gradient-to-br from-purple-600 to-pink-500' : 'bg-gradient-to-br from-slate-800 to-slate-600'}`}>
                          <Box size={36} />
                        </div>
                        <div>
                           <h3 className="text-3xl font-black text-[var(--text-primary)] tracking-tighter uppercase">{source}</h3>
                           <div className="flex items-center gap-3 mt-1">
                              <span className="w-2 h-2 rounded-full bg-emerald-500" />
                              <p className="text-xs text-[var(--text-muted)] font-black uppercase tracking-widest">{items.length} MODELS DETECTED</p>
                           </div>
                        </div>
                     </div>
                     <div className={`w-14 h-14 rounded-full border border-[var(--border)] flex items-center justify-center text-[var(--text-muted)] transition-transform duration-500 ${isExpanded ? 'rotate-180' : ''}`}>
                        <ChevronDown size={24} />
                     </div>
                  </header>

                  <AnimatePresence>
                    {isExpanded && (
                      <motion.div 
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="overflow-hidden"
                      >
                        <motion.div 
                          variants={CONTAINER_VARIANTS}
                          initial="hidden"
                          animate="visible"
                          className="border-t border-[var(--border)] p-4 sm:p-6 md:p-10 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 md:gap-8"
                        >
                           {items.map(m => (
                              <motion.div 
                                key={m.path} 
                                variants={ITEM_VARIANTS}
                                onClick={() => setViewingModel(m)} 
                                className="bg-[var(--bg-input)]/40 border border-[var(--border)] rounded-[1.5rem] sm:rounded-[2rem] md:rounded-[2.5rem] p-5 sm:p-6 md:p-8 hover:border-blue-500/50 transition-all cursor-pointer group/card relative overflow-hidden shadow-sm hover:shadow-2xl hover:-translate-y-1 flex flex-col min-h-[280px] sm:min-h-[320px]"
                              >
                                 <div className="absolute top-0 right-0 p-8 opacity-0 group-hover/card:opacity-100 transition-all translate-x-4 group-hover/card:translate-x-0">
                                    <ExternalLink size={20} className="text-blue-500" />
                                 </div>
                                 
                                 <div className="mb-8 flex justify-between items-start">
                                    <div className={`p-3 rounded-2xl bg-[var(--bg-surface)] border border-[var(--border)] text-blue-500`}>
                                      <Terminal size={20} />
                                    </div>
                                    <span className={`text-xs font-black px-4 py-1.5 rounded-full uppercase tracking-widest border shadow-sm ${m.isSymlink ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' : 'bg-[var(--bg-input)] text-[var(--text-muted)] border-[var(--border)]'}`}>
                                       {m.isSymlink ? 'Centralized' : 'Local Only'}
                                    </span>
                                 </div>
                                 
                                 <h4 className="text-xl md:text-2xl font-black text-[var(--text-primary)] mb-3 tracking-tighter uppercase break-all">{m.name}</h4>
                                 
                                 <div className="flex flex-col gap-1 mb-8 ">
                                    <span className="text-sm font-black uppercase tracking-widest text-blue-500">Source Path</span>
                                    <p className="text-sm md:text-base font-mono break-all font-bold text-[var(--text-primary)] leading-relaxed">{m.path}</p>
                                 </div>
                                 
                                 <div className="flex justify-between items-end mt-auto gap-4">
                                    <div className="flex flex-col gap-1">
                                       <span className="text-xs font-black text-[var(--text-muted)] uppercase tracking-widest">Storage</span>
                                       <span className="text-2xl font-black text-[var(--text-primary)] tracking-tighter">{formatSize(m.size)}</span>
                                    </div>
                                    <div className="flex gap-3 relative z-10">
                                       <button 
                                        onClick={(e) => { e.stopPropagation(); handleOpenFolder(m.path); }} 
                                        className="w-12 h-12 bg-[var(--bg-surface)] text-[var(--text-muted)] hover:text-blue-500 rounded-2xl border border-[var(--border)] flex items-center justify-center transition-all hover:shadow-lg active:scale-90"
                                       >
                                          <FolderOpen size={20} />
                                       </button>
                                       <button 
                                        onClick={(e) => { e.stopPropagation(); handleDelete(m); }} 
                                        className="w-12 h-12 bg-red-500/5 text-red-500 hover:bg-red-500 hover:text-white rounded-2xl border border-red-500/10 flex items-center justify-center transition-all hover:shadow-lg active:scale-90"
                                       >
                                          <Trash2 size={20} />
                                       </button>
                                    </div>
                                 </div>
                              </motion.div>
                           ))}
                        </motion.div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.section>
              );
            })}
          </div>
        )}
      </AnimatePresence>

      <DeleteModal 
        isOpen={deleteModalData.isOpen}
        onClose={() => setDeleteModalData({ ...deleteModalData, isOpen: false })}
        onConfirm={handleModalConfirm}
        models={deleteModalData.models}
        initialAction={deleteModalData.initialAction}
      />
    </motion.div>
  );
}
