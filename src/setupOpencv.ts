import fs from 'fs';
import { getLibs } from '.';
import { BuildContext } from './BuildContext';
import { cmakeArchs, cmakeVsCompilers, defaultCmakeFlags, opencvContribRepoUrl, opencvRepoUrl } from './constants';
import {
  autoBuildFlags,
  buildWithCuda,
  isWithoutContrib,
  numberOfCoresAvailable,
  parseAutoBuildFlags,
} from './env';
import { findMsBuild, pathVersion } from './findMsBuild';
import { AutoBuildFile } from './types';
import { isCudaAvailable, isWin, spawn } from './utils';
import log from 'npmlog';
import rimraf from 'rimraf';
import { promisify } from 'util';

const primraf = promisify(rimraf);

function getMsbuildCmd(sln: string): string[] {
  return [
    sln,
    '/p:Configuration=Release',
    `/p:Platform=${process.arch === 'x64' ? 'x64' : 'x86'}`
  ]
}

function getRunBuildCmd(ctxt: BuildContext, msbuildExe?: string): () => Promise<void> {
  if (msbuildExe) {
    return async () => {
      await spawn(`${msbuildExe}`, getMsbuildCmd('./OpenCV.sln'), { cwd: ctxt.opencvBuild })
      await spawn(`${msbuildExe}`, getMsbuildCmd('./INSTALL.vcxproj'), { cwd: ctxt.opencvBuild })
    }
  }
  return async () => {
    await spawn('make', ['install', `-j${numberOfCoresAvailable()}`], { cwd: ctxt.opencvBuild })
    // revert the strange archiving of libopencv.so going on with make install
    await spawn('make', ['all', `-j${numberOfCoresAvailable()}`], { cwd: ctxt.opencvBuild })
  }
}

function getCudaCmakeFlags(): string[] {
  return [
    '-DWITH_CUDA=ON',
    '-DBUILD_opencv_cudacodec=OFF', // video codec (NVCUVID) is deprecated in cuda 10, so don't add it
    '-DCUDA_FAST_MATH=ON', // optional
    '-DWITH_CUBLAS=ON', // optional
  ];
}

function getSharedCmakeFlags(ctxt: BuildContext): string[] {
  let conditionalFlags = isWithoutContrib()
    ? []
    : [
      '-DOPENCV_ENABLE_NONFREE=ON',
      `-DOPENCV_EXTRA_MODULES_PATH=${ctxt.opencvContribModules}`
    ]

  if (buildWithCuda() && isCudaAvailable()) {
    log.info('install', 'Adding CUDA flags...');
    conditionalFlags = conditionalFlags.concat(getCudaCmakeFlags());
  }

  return defaultCmakeFlags(ctxt)
    .concat(conditionalFlags)
    .concat(parseAutoBuildFlags())
  // .concat(['-DCMAKE_SYSTEM_PROCESSOR=arm64', '-DCMAKE_OSX_ARCHITECTURES=arm64']);
}

function getWinCmakeFlags(ctxt: BuildContext, msversion: string): string[] {
  const cmakeVsCompiler = (cmakeVsCompilers as any)[msversion]
  const cmakeArch = (cmakeArchs as any)[process.arch]

  if (!cmakeVsCompiler) {
    throw new Error(`no cmake vs compiler found for msversion: ${msversion}`)
  }
  if (!cmakeArch) {
    throw new Error(`no cmake arch found for process.arch: ${process.arch}`)
  }

  return [
    '-G',
    `${cmakeVsCompiler}${cmakeArch}`
  ].concat(getSharedCmakeFlags(ctxt))
}

function getCmakeArgs(ctxt: BuildContext, cmakeFlags: string[]): string[] {
  return [ctxt.opencvSrc].concat(cmakeFlags)
}

async function getMsbuildIfWin(): Promise<pathVersion | undefined> {
  if (isWin()) {
    const msbuild = await findMsBuild()
    log.info('install', 'using msbuild:', msbuild)
    return msbuild
  }
  return undefined;
}

function writeAutoBuildFile(ctxt: BuildContext): AutoBuildFile {
  const autoBuildFile: AutoBuildFile = {
    opencvVersion: ctxt.opencvVersion,
    autoBuildFlags: autoBuildFlags(),
    modules: getLibs(ctxt.opencvLibDir)
  }
  log.info('install', 'writing auto-build file into directory: %s', ctxt.autoBuildFile)
  log.info('install', JSON.stringify(autoBuildFile))
  fs.writeFileSync(ctxt.autoBuildFile, JSON.stringify(autoBuildFile, null, 4))
  return autoBuildFile;
}

export async function setupOpencv(ctxt: BuildContext): Promise<void> {
  let keepSource = false;
  const { argv } = process;
  if (argv) {
    if (argv.includes('--keepsources') || argv.includes('--keep-sources') || argv.includes('--keepsource') || argv.includes('--keep-source'))
      keepSource = true;
  }
  const msbuild = await getMsbuildIfWin()
  let cMakeFlags: string[] = [];
  let msbuildPath: string | undefined = undefined;
  // Get cmake flags here to check for CUDA early on instead of the start of the building process
  if (isWin()) {
    if (!msbuild)
      throw Error('Error getting Ms Build info');
    cMakeFlags = getWinCmakeFlags(ctxt, "" + msbuild.version);
    msbuildPath = msbuild.path;
  } else {
    cMakeFlags = getSharedCmakeFlags(ctxt);
  }

  const tag = ctxt.opencvVersion
  log.info('install', 'installing opencv version %s into directory: %s', tag, ctxt.opencvRoot)

  await primraf(ctxt.opencvBuild);
  await primraf(ctxt.opencvSrc);
  await primraf(ctxt.opencvContribSrc);

  fs.mkdirSync(ctxt.opencvBuild, { recursive: true });

  if (isWithoutContrib()) {
    log.info('install', 'skipping download of opencv_contrib since OPENCV4NODEJS_AUTOBUILD_WITHOUT_CONTRIB is set')
  } else {
    await spawn('git', ['clone', '-b', `${tag}`, '--single-branch', '--depth', '1', '--progress', opencvContribRepoUrl], { cwd: ctxt.opencvRoot })
  }
  await spawn('git', ['clone', '-b', `${tag}`, '--single-branch', '--depth', '1', '--progress', opencvRepoUrl], { cwd: ctxt.opencvRoot })

  const cmakeArgs = getCmakeArgs(ctxt, cMakeFlags)
  log.info('install', 'running cmake %s', cmakeArgs)
  await spawn('cmake', cmakeArgs, { cwd: ctxt.opencvBuild })
  log.info('install', 'starting build...')
  await getRunBuildCmd(ctxt, msbuildPath)()

  writeAutoBuildFile(ctxt)
  // cmake -D CMAKE_BUILD_TYPE=RELEASE -D ENABLE_NEON=ON 
  // -D ENABLE_TBB=ON -D ENABLE_IPP=ON -D ENABLE_VFVP3=ON -D WITH_OPENMP=ON -D WITH_CSTRIPES=ON -D WITH_OPENCL=ON -D CMAKE_INSTALL_PREFIX=/usr/local
  // -D OPENCV_EXTRA_MODULES_PATH=/root/[username]/opencv_contrib-3.4.0/modules/ ..
  if (!keepSource) {
    /**
     * DELETE TMP build dirs
     */
    try {
      await primraf(ctxt.opencvSrc)
    } catch (err) {
      log.error('install', 'failed to clean opencv source folder:', err)
      log.error('install', 'consider removing the folder yourself: %s', ctxt.opencvSrc)
    }

    try {
      await primraf(ctxt.opencvContribSrc)
    } catch (err) {
      log.error('install', 'failed to clean opencv_contrib source folder:', err)
      log.error('install', 'consider removing the folder yourself: %s', ctxt.opencvContribSrc)
    }
  }
}
