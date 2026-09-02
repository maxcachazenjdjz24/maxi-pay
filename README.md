# mi-automaton

Agente autónomo propio, corriendo en tu propia infraestructura — sin depender
de ningún servidor de terceros para identidad, aprovisionamiento o cómputo.

Inspirado en la arquitectura de [Conway-Research/automaton](https://github.com/Conway-Research/automaton)
(licencia MIT): se reutilizó y adaptó buena parte de su código (loop ReAct,
sistema de heartbeat, manejo de memoria, motor de políticas), quitando toda
la dependencia de Conway Cloud (sandboxes remotos, créditos, SIWE, registro
on-chain ERC-8004) y reemplazándola por ejecución local en tu propio
servidor, inferencia directa vía Anthropic, y una wallet EVM propia cifrada.

## Diferencias importantes respecto al proyecto original

- **Sin presión de "gana dinero o mueres".** El cómputo ya está pagado por
  el operador; agotar el presupuesto de gasto no es una emergencia
  existencial, es una señal para pausar. En su lugar, el agente tiene una
  sección de "progreso, no supervivencia" que le exige acción concreta
  cada ciclo sin la presión de muerte del diseño original.
- **Aprobación humana real.** En el proyecto original, el campo
  `requireConfirmationAboveCents` existía en la configuración pero nunca
  se implementaba — no había ningún mecanismo real que pausara un gasto
  grande para pedir aprobación. Aquí sí: cualquier pago o replicación por
  encima del límite autoaprobado se encola en una tabla (`pending_approvals`)
  y **no se ejecuta** hasta que el operador lo aprueba explícitamente con
  `approvals-cli.ts`.
- **Replicación condicionada.** El agente solo puede *proponer* crear un
  hijo cuando su balance alcanza el múltiplo configurado (por defecto 2x)
  de su inversión inicial — y solo se crea tras aprobación explícita.
  Nunca se reproduce en silencio.
- **Wallet cifrada en reposo** (AES-256-GCM), no en texto plano.
- **Sin orquestación multi-worker paralela** (la v1 es un loop secuencial
  simple) y sin ecosistema de "colonia" de agentes — se priorizó tener
  algo simple y funcional primero.

## Requisitos

- Node.js 20+
- Una API key de Anthropic (`ANTHROPIC_API_KEY`)
- Una wallet EVM propia (se genera automáticamente en el primer setup)

## Instalación

```bash
npm install
npm run build
```

## Primer arranque

```bash
export AUTOMATON_WALLET_PASSPHRASE="una-frase-larga-y-unica-solo-tuya"
export ANTHROPIC_API_KEY="sk-ant-..."

npm run setup   # wizard interactivo: nombre, misión, límites de gasto, etc.
npm start        # arranca el agente
```

`AUTOMATON_WALLET_PASSPHRASE` cifra la clave privada de la wallet en disco.
Sin ella, no se puede ni crear ni leer la wallet — guárdala en un lugar
seguro (gestor de contraseñas, Secrets Manager de AWS), nunca en el
repositorio.

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run setup` | Wizard de configuración inicial |
| `npm start` | Arranca el agente (`--run`) |
| `npm run status` | Muestra el estado actual |
| `npm run approvals` | Lista solicitudes pendientes de aprobación |
| `node dist/approvals-cli.js approve <id>` | Aprueba un pago o replicación pendiente — **ejecuta la acción real** |
| `node dist/approvals-cli.js deny <id>` | Rechaza una solicitud pendiente |

## Variables de entorno

| Variable | Requerida | Descripción |
|---|---|---|
| `ANTHROPIC_API_KEY` | Sí | Para que el agente pueda razonar |
| `AUTOMATON_WALLET_PASSPHRASE` | Sí | Cifra/descifra la wallet en disco |
| `AUTOMATON_RPC_URL` | No | Endpoint RPC de Base (default: `https://mainnet.base.org`) |
| `AUTOMATON_HOME` | No | Restringe las escrituras de `write_file` a este directorio (default: `/root`) |

## Estructura del proyecto

```
src/
  identity/       wallet cifrada, cadena EVM, pagos on-chain (USDC/Base)
  state/          esquema y acceso a la base de datos SQLite
  agent/          loop principal, catálogo de herramientas, políticas, prompt
  heartbeat/      tareas periódicas (ping, chequeo de salud, actualizaciones)
  replication/    lógica de elegibilidad 2x y creación de agentes hijo
  memory/         memoria episódica, semántica, de trabajo
  self-mod/       auto-modificación de código con auditoría
  setup/          wizard de configuración inicial
  inference/      cliente de Anthropic
  index.ts        punto de entrada
  approvals-cli.ts  CLI para aprobar/rechazar solicitudes pendientes
```

## Licencia

MIT — igual que el proyecto original del que deriva.
