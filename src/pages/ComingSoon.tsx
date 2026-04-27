const ComingSoon = () => {
  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <section className="mx-auto flex min-h-screen w-full max-w-4xl flex-col items-center justify-center px-6 py-16 text-center">
        <div className="mb-6 rounded-full border border-cyan-400/30 bg-cyan-400/10 px-4 py-2 text-sm font-semibold uppercase tracking-[0.32em] text-cyan-200">
          Proximamente
        </div>
        <h1 className="text-4xl font-bold tracking-tight text-white sm:text-6xl">
          Plataforma PPG en preparacion
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-300">
          Estamos preparando una experiencia general segura para la publicacion
          publica. El motor biometrico permanece fuera de la superficie activa
          hasta completar las revisiones clinicas y operativas.
        </p>
        <div className="mt-10 rounded-2xl border border-slate-800 bg-slate-900/70 px-6 py-5 text-left shadow-2xl shadow-cyan-950/20">
          <p className="text-sm font-medium text-slate-200">Estado del deploy</p>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            GitHub y Vercel sirven esta pagina general mientras el producto
            permanece en modo de lanzamiento controlado.
          </p>
        </div>
      </section>
    </main>
  );
};

export default ComingSoon;
