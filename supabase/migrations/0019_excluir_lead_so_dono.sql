-- =============================================================================
-- 0019 — Excluir cliente/lead: só o proprietário
--
-- Por padrão (0002) o delete das tabelas de negócio é de proprietário OU gerente.
-- Para clientes (leads), o dono quer restringir a EXCLUSÃO só ao proprietário —
-- apagar um lead é perder histórico de contato, então fica no dono. Vendedor e
-- gerente seguem podendo ver e editar; só não apagam. Enforce no servidor (RLS),
-- não só na tela.
-- =============================================================================

drop policy if exists apagar on public.clientes;
create policy apagar on public.clientes
  for delete to authenticated
  using (loja_id = app.loja_id() and app.papel() = 'proprietario');
