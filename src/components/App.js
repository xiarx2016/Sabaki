const fs = require('fs')
const EventEmitter = require('events')
const {ipcRenderer, remote} = require('electron')
const {app, Menu} = remote
const {h, render, Component} = require('preact')
const classNames = require('classnames')

const ThemeManager = require('./ThemeManager')
const MainView = require('./MainView')
const LeftSidebar = require('./LeftSidebar')
const Sidebar = require('./Sidebar')
const DrawerManager = require('./DrawerManager')
const InputBox = require('./InputBox')
const BusyScreen = require('./BusyScreen')
const InfoOverlay = require('./InfoOverlay')

const deadstones = require('@sabaki/deadstones')
const influence = require('@sabaki/influence')

const Board = require('../modules/board')
const boardmatcher = require('../modules/boardmatcher')
const dialog = require('../modules/dialog')
const enginesyncer = require('../modules/enginesyncer')
const fileformats = require('../modules/fileformats')
const gametree = require('../modules/gametree')
const gtp = require('../modules/gtp')
const helper = require('../modules/helper')
const setting = remote.require('./setting')
const {sgf} = fileformats
const sound = require('../modules/sound')

//xiarx 
//2018.06.14 复盘时，黑方白方选手都显示为棋思智能棋盘
//           废弃函数getColorByStep，以getColorByNode取代
//           增加了对phoenixGo引擎的支持
//2018.06.13 修正了死活题中，可能存在应该黑先,但this.state.currentPlayer却是-1等现象引发的不会发出命令的错误，
//           以及切换当前树后的黑白交替和play、guess切换的错误
//2018.06.08 增加对死后题其他分支的支持，及结果提示文字返回
//2018.06.06 1 增加全局对象this.qsgo，增加变量不再放在this.state下，减少对原有程序的影响
//           2 增加远程死后题其它分支的支持
//2018.06.05 增加远程死活题
//2018.05.29 增加了打开sgf文件复盘的功能
//           增加远程复盘功能


//socket server
const net = require('net');
const SocketListenPort = 7003;//监听端口
const {Command} = require('../modules/gtp')
/////////////////////////////////////

class App extends Component {
    constructor() {
        super()
        window.sabaki = this

        let emptyTree = gametree.new()
        emptyTree.nodes.push({})

        this.state = {
            mode: 'play',
            openDrawer: null,
            busy: 0,
            fullScreen: false,
            showMenuBar: null,
            zoomFactor: null,

            representedFilename: null,
            gameTrees: [emptyTree],
            treePosition: [emptyTree, 0],

            // Bars

            undoable: false,
            undoText: 'Undo',
            selectedTool: 'stone_1',
            scoringMethod: null,
            findText: '',
            findVertex: null,
            deadStones: [],
            blockedGuesses: [],

            // Goban

            highlightVertices: [],
            heatMap: null,
            showCoordinates: null,
            showMoveColorization: null,
            showNextMoves: null,
            showSiblings: null,
            fuzzyStonePlacement: null,
            animatedStonePlacement: null,
            animatedVertex: null,

            // Sidebar

            consoleLog: [],
            showConsole: setting.get('view.show_leftsidebar'),
            leftSidebarWidth: setting.get('view.leftsidebar_width'),
            showGameGraph: setting.get('view.show_graph'),
            showCommentBox: setting.get('view.show_comments'),
            sidebarWidth: setting.get('view.sidebar_width'),
            graphGridSize: null,
            graphNodeSize: null,

            // Engines

            engines: null,
            attachedEngines: [null, null],
            engineCommands: [[], []],
            generatingMoves: false,

            // Drawers

            preferencesTab: 'general',

            // Input Box

            showInputBox: false,
            inputBoxText: '',
            onInputBoxSubmit: helper.noop,
            onInputBoxCancel: helper.noop,

            // Info Overlay

            infoOverlayText: '',
            showInfoOverlay: false            

        }

        this.events = new EventEmitter()
        this.appName = app.getName()
        this.version = app.getVersion()
        this.window = remote.getCurrentWindow()

        this.treeHash = this.generateTreeHash()
        this.attachedEngineControllers = [null, null]
        this.engineStates = [null, null]

        // Expose submodules

        this.modules = {Board, boardmatcher, dialog, enginesyncer,
            fileformats, gametree, gtp, helper, setting, sound}

        // Bind state to settings
        setting.events.on('change', ({key}) => this.updateSettingState(key))
        this.updateSettingState()

        if (setting.get('debug.renderDev_tools')) {
            window.openDevTools()
        } 

        //增加一个全局对象,存放相关的全局变量
        this.qsgo = {
        	gameOverFlag : false , 
        	currentAction : '' , 
        	currentFile : '' ,         	
        	currentStep : 0 , //切换树时，会清零        	
        	currentTree : [emptyTree] ,	
			currentBrotherTrees  : [emptyTree] , 
			currentVertexOptions : '' , 
			exerciseResult : 'R' ,//不准确，目前暂时不用
			guessPlayer : 'B' //做题方，死活题中谁先走，谁就是做题方

        }
        
    }

    componentDidMount() {    	

        window.addEventListener('contextmenu', evt => {
            evt.preventDefault()
        })

        window.addEventListener('load', () => {
            this.events.emit('ready')
            this.window.show()
        })

        ipcRenderer.on('load-file', (evt, ...args) => {
            setTimeout(() => this.loadFile(...args), setting.get('app.loadgame_delay'))
        })

        this.window.on('focus', () => {
            if (setting.get('file.show_reload_warning')) {
                this.askForReload()
            }

            ipcRenderer.send('build-menu', this.state.busy > 0)
        })

        this.window.on('resize', () => {
            clearTimeout(this.resizeId)

            this.resizeId = setTimeout(() => {
                if (!this.window.isMaximized() && !this.window.isMinimized() && !this.window.isFullScreen()) {
                    let [width, height] = this.window.getContentSize()
                    setting.set('window.width', width).set('window.height', height)
                }
            }, 1000)
        })

        // Handle main menu items

        let menuData = require('../menu')

        let handleMenuClicks = menu => {
            for (let item of menu) {
                if ('click' in item) {
                    ipcRenderer.on(`menu-click-${item.id}`, () => {
                        if (!this.state.showMenuBar) this.window.setMenuBarVisibility(false)
                        dialog.closeInputBox()
                        item.click()
                    })
                }

                if ('submenu' in item) {
                    handleMenuClicks(item.submenu)
                }
            }
        }

        handleMenuClicks(menuData)

        // Handle mouse wheel

        for (let el of document.querySelectorAll('#main main, #graph')) {
            el.addEventListener('wheel', evt => {
                evt.preventDefault()
                
                //debugger//测试鼠标滚动事件 
                if (!this.state.showCommentBox) return//added by xiarx 只有打开注解页面时(复盘)才允许滚轮起作用

                if (this.residueDeltaY == null) this.residueDeltaY = 0
                this.residueDeltaY += evt.deltaY

                if (Math.abs(this.residueDeltaY) >= setting.get('game.navigation_sensitivity')) {
                    this.goStep(Math.sign(this.residueDeltaY))
                    this.residueDeltaY = 0
                }
            })
        }

        // Handle file drag & drop

        document.body.addEventListener('dragover', evt => evt.preventDefault())
        document.body.addEventListener('drop', evt => {
            evt.preventDefault()

            if (evt.dataTransfer.files.length === 0) return
            this.loadFile(evt.dataTransfer.files[0].path)
        })

        // Handle escape key

        document.addEventListener('keyup', evt => {
            if (evt.keyCode === 27) {
                // Escape

                if(!["NewFile","newGameRemote"].includes(this.qsgo.currentAction)) return //added 20180608

                if (this.state.generatingMoves) {
                    this.stopGeneratingMoves()
                    this.setBusy(false) //
                //added by xiarx//第一次按esc暂停，第二次按恢复
                } else if (this.state.generatingMoves!=true) {
                    this.startGeneratingMoves()
                    this.setBusy(true) //
                /////////////////////////////////
                } else if (this.state.openDrawer != null) {
                    this.closeDrawer()
                } else if (this.state.mode !== 'play') {
                    this.setMode('play')
                } else if (this.state.fullScreen) {
                    this.setState({fullScreen: false})
                }
            }
        })

        // Handle window closing

        window.addEventListener('beforeunload', evt => {
            if (this.closeWindow) return

            evt.returnValue = ' '

            setTimeout(() => {
                if (this.askForSave()) {
                    this.detachEngines()
                    this.closeWindow = true
                    this.window.close()
                }
            })
        })

        this.newFile()

        //xiarx  
        this.socketServerListen()
        ////////////////////////////////////

    }

    componentDidUpdate(_, prevState = {}) {
        // Update title

        let {basename} = require('path')
        let title = this.appName
        let {representedFilename, gameTrees, treePosition: [tree, ]} = this.state

        if (representedFilename)
            title = basename(representedFilename)
        if (gameTrees.length > 1)
            title += ' — Game ' + (this.inferredState.gameIndex + 1)
        if (representedFilename && process.platform != 'darwin')
            title += ' — ' + this.appName

        if (document.title !== title)
            document.title = title

        // Handle full screen & menu bar

        if (prevState.fullScreen !== this.state.fullScreen) {
            if (this.state.fullScreen) this.flashInfoOverlay('Press Esc to exit full screen mode')
            this.window.setFullScreen(this.state.fullScreen)
        }

        if (prevState.showMenuBar !== this.state.showMenuBar) {
            if (!this.state.showMenuBar) this.flashInfoOverlay('Press Alt to show menu bar')
            this.window.setMenuBarVisibility(this.state.showMenuBar)
            this.window.setAutoHideMenuBar(!this.state.showMenuBar)
        }

        // Handle sidebar showing/hiding

        if (prevState.showLeftSidebar !== this.state.showLeftSidebar
        || prevState.showSidebar !== this.state.showSidebar) {
            let [width, height] = this.window.getContentSize()
            let widthDiff = 0

            if (prevState.showSidebar !== this.state.showSidebar) {
                widthDiff += this.state.sidebarWidth * (this.state.showSidebar ? 1 : -1)
            }

            if (prevState.showLeftSidebar !== this.state.showLeftSidebar) {
                widthDiff += this.state.leftSidebarWidth * (this.state.showLeftSidebar ? 1 : -1)
            }

            if (!this.window.isMaximized() && !this.window.isMinimized() && !this.window.isFullScreen()) {
                this.window.setContentSize(width + widthDiff, height)
            }
        }

        // Handle zoom factor

        if (prevState.zoomFactor !== this.state.zoomFactor) {
            this.window.webContents.setZoomFactor(this.state.zoomFactor)
        }
    }

    //socketServer方式
    socketServerListen(){            
            //debugger
            let me = this
            let socktServer = net.createServer(function(socket){
            // 我们获得一个连接 - 该连接自动关联一个socket对象
            console.log('connect: ' + socket.remoteAddress + ':' + socket.remotePort);
            socket.setEncoding('binary');
            //超时事件
            //  socket.setTimeout(timeout,function(){
            //    console.log('连接超时');
            //    socket.end();
            //  });
           
           socket.write('Connected to sabakiQsGo!')
          
          //接收到数据
          socket.on('data',function(data){
            //debugger 
            console.log('recv:' + data);            
            me.parseCommands(data) //解析处理命令
         
          });
          //数据错误事件
          socket.on('error',function(exception){
            console.log('socket error:' + exception);
            socket.end();
          });
          //客户端关闭事件
          socket.on('close',function(data){
            console.log('close: ' +
              socket.remoteAddress + ' ' + socket.remotePort);
          });
        }).listen(SocketListenPort);

        //服务器监听事件
        socktServer.on('listening',function(){
          console.log("socktServer listening:" + socktServer.address().port);
        });
        //服务器错误事件
        socktServer.on("error",function(exception){
          console.log("socktServer error:" + exception);
        });
            
    }

    parseCommands(commandStr){
    	//debugger

        let commandObj = JSON.parse(commandStr)
        if(commandObj.COMMAD=="NEWGAME"){          
            //{"COMMAD":"NEWGAME","PB":"NULL","PW":"LEELA","HA":3}  
            this.newGameByRemote(commandObj)
        }else if(commandObj.COMMAD=="LOADGAME"){
        	//{"COMMAD":"LOADGAME","PATH":"C:\\\\QSGO\\\\QSSABAKI\\\\SGFFILES\\\\1.SGF"}
        	this.LoadGameByRemote(commandObj)
        }else if(commandObj.COMMAD=="EXERCISE"){
        	//{"COMMAD":"EXERCISE","PATH":"C:\\\\QsGo\\\\QsSabaki\\\\sgffiles\\\\0001.sgf"}
        	this.ExerciseByRemote(commandObj)
        }

    }

    //远程下棋
    async newGameByRemote(commandObj){
    
        //evt.preventDefault() 

        if (!this.askForSave()) return
        //if (showInfo && this.state.openDrawer === 'info') this.closeDrawer()
        this.setMode('play')

        this.clearUndoPoint()
        this.detachEngines()
        this.clearConsole()

        this.state.showCommentBox = false//added by xiarx 下棋时关掉注解页面
        this.state.showGameGraph = false//added by xiarx 下棋时关掉树页面
        this.qsgo.gameOverFlag = false//added by xiarx 复盘时允许鼠标点击
        this.qsgo.currentAction = 'newGameRemote' 
        
        await this.waitForRender()     
        
        //{"COMMAD":"NEWGAME","PB":"NULL","PW":"LEELA","HA":3,"KM":7.5}  
        this.state.gameInfo.handicap = commandObj.HA
        if(commandObj.HA > 0) {
            this.state.currentPlayer = -1 //有让子的话，白先走   
        }else{
            this.state.currentPlayer = 1 //没有让子的话，黑先走   
        }
        this.state.gameInfo.komi = commandObj.KM
        
        //处理白方
        if(commandObj.PW=="NULL"){
            
        }else{
            this.state.gameInfo.whiteName = commandObj.PW   
            this.state.gameInfo.playerNames[1] = commandObj.PW 
        }

        //加载引擎   
        let engines_list = setting.get('engines.list')       
        let {engines} = this.state
        engines.length = 2    

        //黑
        if (commandObj.PB=="AQ"){
            engines[0] = engines_list[0]
            this.state.gameInfo.blackName = engines_list[0].name   
            this.state.gameInfo.playerNames[0] = engines_list[0].name
        }else if(commandObj.PB=="GNUGO"){
            engines[0] = engines_list[1] 
            this.state.gameInfo.blackName = engines_list[1].name   
            this.state.gameInfo.playerNames[0] = engines_list[1].name          
        }else if(commandObj.PB=="LEELA"){
            engines[0] = engines_list[2]   
            this.state.gameInfo.blackName = engines_list[2].name   
            this.state.gameInfo.playerNames[0] = engines_list[2].name                
        }else if(commandObj.PB=="PHOENIXGO"){
            engines[0] = engines_list[3]   
            this.state.gameInfo.blackName = engines_list[3].name   
            this.state.gameInfo.playerNames[0] = engines_list[3].name 
        }else if (commandObj.PB=="QSBOARD"){
            engines[0] = engines_list[4]
            this.state.gameInfo.blackName = engines_list[4].name   
            this.state.gameInfo.playerNames[0] = engines_list[4].name 
        }else{
            engines[0] = null
            this.state.gameInfo.blackName = null   
            this.state.gameInfo.playerNames[0] = null 
        }
      
        //白        
        if (commandObj.PW=="AQ"){
            engines[1] = engines_list[0]
            this.state.gameInfo.whiteName = engines_list[0].name   
            this.state.gameInfo.playerNames[1] = engines_list[0].name  
        }else if(commandObj.PW=="GNUGO"){
            engines[1] = engines_list[1]     
            this.state.gameInfo.whiteName = engines_list[1].name   
            this.state.gameInfo.playerNames[1] = engines_list[1].name        
        }else if(commandObj.PW=="LEELA"){
            engines[1] = engines_list[2]   
            this.state.gameInfo.whiteName = engines_list[2].name   
            this.state.gameInfo.playerNames[1] = engines_list[2].name                 
        }else if(commandObj.PW=="PHOENIXGO"){
            engines[1] = engines_list[3]    
            this.state.gameInfo.whiteName = engines_list[3].name   
            this.state.gameInfo.playerNames[1] = engines_list[3].name         
        }else if (commandObj.PW=="QSBOARD"){
            engines[1] = engines_list[4]
            this.state.gameInfo.whiteName = engines_list[4].name   
            this.state.gameInfo.playerNames[1] = engines_list[4].name 
        }else{
            engines[1] = null
            this.state.gameInfo.whiteName = null   
            this.state.gameInfo.playerNames[1] = null 
        }    

        let emptyTree = this.getEmptyGameTree()
        if(commandObj.HA>0){
            emptyTree.nodes[0].HA = commandObj.HA    
        }else{
            if(emptyTree.nodes[0].HA) delete emptyTree.nodes[0].HA //删除属性
        }        

        this.setState({
            openDrawer:  null,
            gameTrees: [emptyTree],
            rootTree:[emptyTree],//added by xiarx
            representedFilename: null
        })

        this.setCurrentTreePosition(emptyTree, 0)

        this.treeHash = this.generateTreeHash()
        this.fileHash = this.generateFileHash()

        sound.playNewGame()
        
        let keys = ['blackName', 'blackRank', 'whiteName', 'whiteRank',
            'gameName', 'eventName', 'date', 'result', 'komi']

        let data = keys.reduce((acc, key) => {
            acc[key] = Array.isArray(this.state[key])
                && this.state[key].every(x => x == null) ? null : this.state[key]
            return acc
        }, {})

        data.handicap = this.state.gameInfo.handicap
        data.size = this.state.gameInfo.size        

        sabaki.setGameInfo(emptyTree, data)
       
        sabaki.attachEngines(...engines)
        await sabaki.waitForRender()        

        let i = this.state.currentPlayer > 0 ? 0 : 1
        let startGame = setting.get('gtp.start_game_after_attach')

        if (startGame && sabaki.attachedEngineControllers[i] != null) {
            sabaki.startGeneratingMoves()
        }

    }    

    //远程复盘
    async LoadGameByRemote(commandObj)
    {
    	
        if (!this.askForSave()) return        

        let filename = commandObj.PATH
        if (!filename) {
            dialog.showOpenDialog({
                properties: ['openFile'],
                filters: [...fileformats.meta, {name: 'All Files', extensions: ['*']}]
            }, ({result}) => { 
                if (result) commandObj.PATH = result[0]     
                if (commandObj.PATH) {
                    this.LoadGameByRemote(commandObj)                        
                }
            })

            return
        }
              
        this.state.showCommentBox = true//added by xiarx 复盘时自动打开注解页面
        this.state.showGameGraph = true//added by xiarx 复盘时自动打开树页面
        this.qsgo.gameOverFlag = false//added by xiarx 复盘时允许鼠标点击
        this.qsgo.currentAction = 'loadGameRemote' //added by xiarx 当前执行菜单 主要用于让子棋的  

        let {extname} = require('path')
        let extension = extname(filename).slice(1)
        let content = fs.readFileSync(filename, {encoding: 'binary'})

        let success = await this.loadContent(content, extension, {suppressAskForSave: true})

        if (success) {
            this.setState({representedFilename: filename})
            this.fileHash = this.generateFileHash()

            if (setting.get('game.goto_end_after_loading')) {
                this.goToEnd()
            }

            //debugger
            //复盘时，黑方作为引擎，但是双方棋手名称都显示为棋思智能棋盘
            //console.log('原黑方棋手：' + this.state.gameInfo.playerNames[0])
            //let oriBlackPlayer = this.state.gameInfo.playerNames[0]
            let oriWhitePlayer = this.state.gameInfo.playerNames[1]
            // 驱动智能棋盘gtp引擎 xiarx 20180522     
            await this.attachQsGtp()

            //改掉白方名称
            //this.state.gameInfo.playerNames[0] = oriBlackPlayer
            this.state.gameInfo.playerNames[1] = oriWhitePlayer
            //初始化当前步数
            this.qsgo.currentStep = 0

			//根据让子信息，想gtp引擎发送play命令
			let response = await this.playHandicapStep()
			if(!response) return

			//自动播放 xiarx 20180524	        
            setTimeout(() => {
                this.playNextStep()
            }, setting.get('gtp.move_delay'))               
        }
    }

    //远程死活题练习
    async ExerciseByRemote(commandObj)
    {
    	//debugger 
        if (!this.askForSave()) return        

        let filename = commandObj.PATH
        if (!filename) {
            dialog.showOpenDialog({
                properties: ['openFile'],
                filters: [...fileformats.meta, {name: 'All Files', extensions: ['*']}]
            }, ({result}) => {          
                if (result) commandObj.PATH = result[0]       
                if (commandObj.PATH) {
                    this.ExerciseByRemote(commandObj)                        
                }
            })
            return
        } 
             
        this.state.showCommentBox = true//added by xiarx 练习自动打开注解页面
        this.state.showGameGraph = true//added by xiarx 练习时自动打开树页面
        this.qsgo.gameOverFlag = false//added by xiarx 复盘时允许鼠标点击      
        this.qsgo.currentAction = 'exerciseRemote' //added by xiarx 当前执行菜单 主要用于让子棋的  

        let {extname} = require('path')
        let extension = extname(filename).slice(1)
        let content = fs.readFileSync(filename, {encoding: 'binary'})

        this.qsgo.currentFile = filename

        let success = await this.loadContent(content, extension, {suppressAskForSave: true})

        if (success) {
            this.setState({representedFilename: filename})
            this.fileHash = this.generateFileHash()

            if (setting.get('game.goto_end_after_loading')) {
                this.goToEnd()
            }            

            // 驱动智能棋盘gtp引擎 xiarx 20180522     
            await this.attachQsGtp()             

			//死活题初始化子
			let response = await this.playAncientStep()
			if(!response) return

			////////////////////////////////////////
			let exTree = this.state.treePosition[0]		
			let nodesLength = exTree.nodes.length 
			let subtreesLength = exTree.subtrees.length //总分支数

			//默认选择最左边的分支 这里需要更加通用一点
			if(nodesLength > 1){				
				//如果根节点之后还有其它节点,预留，目前还没有遇到
				//.............
				this.qsgo.currentStep = 0				
				
				//this.setCurrentTreePosition(exTree,this.state.currentStep)				
				//await this.waitForRender()	
				this.qsgo.currentTree  = 	exTree		
				this.qsgo.currentBrotherTrees =	null	

			}else if(nodesLength==1){
				if(subtreesLength > 1){
					this.qsgo.currentStep = 0					
					this.qsgo.currentTree  = 	exTree.subtrees[0]	
					this.qsgo.currentBrotherTrees =	exTree.subtrees	
					//默认哪个分支需要根据gtp引擎回复情况确定		
				}else{
					//只有初始节点，后续节点，无子树
					return //结束？
				}				
			}else{
				return //错误情况？？？
			}	
		
			//开始做题         			
			//用下一步的B W来判断黑白
			if(this.qsgo.currentTree.nodes[0].B){				
				this.qsgo.guessPlayer = 'B'
				//this.state.currentPlayer = 1
			}else if(this.qsgo.currentTree.nodes[0].W){				
				this.qsgo.guessPlayer = 'W'
				//this.state.currentPlayer = -1
			}else{
				return //错误文件
			}

            setTimeout(() => {
                this.playExerciseStep()
            }, setting.get('gtp.move_delay'))
            
        }
    }

    //Added by xiarx
    //黑方加载棋思智能棋盘gtp引擎,
    //本函数只用于远程复盘和远程练习题
    async attachQsGtp(){
    	let engines_list = setting.get('engines.list')       
        let {engines} = this.state
        engines.length = 1    
        engines[0] = engines_list[4]       
        sabaki.attachEngines(...engines)
    }    

	//更准确，更通用
	getColorByNode(node){
		let colors = ['B','W']
		let colorValues = [1,-1]
		
		let colorObj = {}		 		
		if(node.B){
			colorObj.color = colors[0]
			colorObj.value = colorValues[0]
		}else if(node.W){
			colorObj.color = colors[1]
			colorObj.value = colorValues[1]		
		}		
		return colorObj
	}

	getVertexByCoord(stone){
		let alphaG = 'ABCDEFGHJKLMNOPQRSTUVWXYZ'
		let Vertex = alphaG[stone[0]] + (19 - stone[1])
		return Vertex
	}

	getVertexByAlphaCoord(AlphaCoord){
		//将字母坐标转换成gtp坐标Vertex 
    	//在sgf文件中可以有 i ,在gtp命令中，不能有 i 
    	//gtp x轴 A ~ T(无i) y轴 1-19 第一象限 原点在左下
    	//aa => a19  as => a1     	
    	let alphaS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'     	
    	let alphaG = 'ABCDEFGHJKLMNOPQRSTUVWXYZ'
    	
    	let alphaTemp = alphaG[alphaS.indexOf(AlphaCoord[1].toUpperCase())]
    	let currentVertex = alphaG[alphaS.indexOf(AlphaCoord[0].toUpperCase())]+(19 - alphaG.indexOf(alphaTemp))
    	return currentVertex
	}

	//从一颗树上根据步数活动gtp坐标
	getVertexByStep(currentTree,currentStep){
		let currentCoord = ''   
		if(currentTree.nodes[currentStep].B){
			currentCoord = currentTree.nodes[currentStep].B[0]
		}else if(currentTree.nodes[currentStep].W){
			currentCoord = currentTree.nodes[currentStep].W[0] 
		}

    	let currentVertex = this.getVertexByAlphaCoord(currentCoord)
    	return currentVertex
	}		

	//发送gtp命令,目前只支持play guess，而且只用于远程复盘和远程死活题
    async sendGtpCommand(actionStr,colorObj,currentVertex){
    	if(!['B', 'W'].includes(colorObj.color)) return false
    	let controller = this.attachedEngineControllers[0] //colorObj.value > 0 ? this.attachedEngineControllers[0] :  this.attachedEngineControllers[1]
    	let response = await controller.sendCommand(new Command(null, actionStr, colorObj.color, currentVertex))
    	return response
    }

    //向gtp引擎发送摆放让子的命令
    async playHandicapStep(){
    	let HA = this.state.gameInfo.handicap
    	//取让子位置
    	let gametree  = this.modules.gametree
    	let root = this.modules.gametree.getRoot(this.state.treePosition[0])
    	let board = gametree.getBoard(root, 0)
        let stones = board.getHandicapPlacement(+HA) 	// [3,4]
        //向gtp 发送让子 
        for(let i=0;i<stones.length;i++){
        	let vertex = this.getVertexByCoord(stones[i])
        	let controller = this.attachedEngineControllers[0]
        	let response = await controller.sendCommand(new Command(null, 'play', 'B', vertex))
        	if (response.error) {
    			return false	    	    		
    		}    	    		
        }
        return true	
	}

	//向gtp引擎发送下一步棋的命令
	async playNextStep(){
		this.qsgo.currentStep ++		
		//需要检测是否到了最后一步
		if(this.qsgo.currentStep >= this.state.treePosition[0].nodes.length ) {
			console.log('复盘结束，共' + ' ' + this.qsgo.currentStep + ' 手。')
			//done XXX 			
			let controller = this.attachedEngineControllers[0]
			await controller.sendCommand(new Command(null, 'done', 'XXX'))//后续需取出对局结果			
			//this.state.currentStep = 0			
			return	
		}

		//在棋盘上显示当前步数
		this.setCurrentTreePosition(this.state.treePosition[0],this.qsgo.currentStep)
		await this.waitForRender()
		
		//给gtp引擎发命令		
		let colorObj = this.getColorByNode(this.state.gameTrees[0].nodes[this.qsgo.currentStep]) //直接从树上取黑白，不用通过步数计算

		let currentVertex = this.getVertexByStep(this.state.gameTrees[0],this.qsgo.currentStep)		
    	let response = await this.sendGtpCommand('play',colorObj,currentVertex)  

    	if(!response.error){
    		setTimeout(() => {
                this.playNextStep()
            }, setting.get('gtp.move_delay'))
    	}
	}

	//远程死活题中的题干棋子
	async playAncientStep(){
    	//取死活题的初始棋子位置
    	let gametree  = this.state.treePosition[0]
    	
    	if(gametree.nodes[0].AB){
    		//向gtp 发送黑子 
	        for(let i=0;i<gametree.nodes[0].AB.length;i++){
	        	let vertexB = this.getVertexByAlphaCoord(gametree.nodes[0].AB[i])
	        	let controller = this.attachedEngineControllers[0]
	        	let response = await controller.sendCommand(new Command(null, 'play', 'B', vertexB))
	        	if (response.error) {
	    			return false	    	    		
	    		}    	    		
	        }	
    	}
        if(gametree.nodes[0].AW){
	        //向gtp 发送白子 
	        for(let j=0;j<gametree.nodes[0].AW.length;j++){
	        	let vertexW = this.getVertexByAlphaCoord(gametree.nodes[0].AW[j])
	        	let controller = this.attachedEngineControllers[0]
	        	let response = await controller.sendCommand(new Command(null, 'play', 'W', vertexW))
	        	if (response.error) {
	    			return false	    	    		
	    		}    	    		
	        }
	    }

        return true	
	}

	
	//处理死活题中的每一步
	async playExerciseStep(){	
		
		if(this.qsgo.currentStep==0){
			//如果处在分支的第一手，需要取出兄弟分支的各个位置，作为guess参数的			
			if(this.qsgo.currentBrotherTrees.length > 1){				
				this.qsgo.currentVertexOptions = ''
				for(let i=0;i<this.qsgo.currentBrotherTrees.length;i++){										
					let colorObj = this.getColorByNode(this.qsgo.currentBrotherTrees[0].nodes[0]) //直接从树上取黑白，不用通过步数计算
					let coordOption = colorObj.value > 0 ? this.qsgo.currentBrotherTrees[i].nodes[0].B[0] : this.qsgo.currentBrotherTrees[i].nodes[0].W[0]
					//转换格式 sgf -> gtp
					let vertexOption = this.getVertexByAlphaCoord(coordOption)

					if(i>0)  this.qsgo.currentVertexOptions += ','
					this.qsgo.currentVertexOptions += vertexOption
				}					
			}			
		}
	
		this.qsgo.currentStep ++	
		if (this.qsgo.currentStep > this.qsgo.currentTree.nodes.length){			
			if(this.qsgo.currentTree.subtrees.length > 0){
				//本分支走完，有子树，切换到第一个分支				
				this.qsgo.currentBrotherTrees = this.qsgo.currentTree.subtrees 
				this.qsgo.currentTree = this.qsgo.currentTree.subtrees[0] //切记！！！当前树降级，必须同时修改兄弟树组，而且要先改兄弟树组，再改当前树！！！
				this.qsgo.currentStep = 0

				setTimeout(() => {
	                this.playExerciseStep()
	            }, setting.get('gtp.move_delay'))		

	            return //切换分支后必须跳出，后面语句不能继续执行

			}else{
				//debugger
				//答题结束		
				console.log('答题结束。（ ' + this.qsgo.currentExercise + ' ）')
				//done X XXXX 
				//其中第一个参数X为 “R” 时表示答对，为 “E”表示答错。可能不靠谱
				//第二个参数 XXXX 表示结果提示信息，比如“白无法做活，恭喜答对”等，暂时可以不用。
				let controller = this.attachedEngineControllers[0]

				let commentStr = ''
				if(this.qsgo.currentTree.nodes[this.qsgo.currentTree.nodes.length  -1].C){
					commentStr = this.qsgo.currentTree.nodes[this.qsgo.currentTree.nodes.length  -1].C[0]
				} 
				await controller.sendCommand(new Command(null, 'done', this.qsgo.exerciseResult , commentStr))

				this.qsgo.currentExercise = ''				
				this.qsgo.currentStep = 0				
				this.qsgo.currentTree = null
				this.qsgo.currentBrotherTrees = null
				this.qsgo.exerciseResult = 'R'
			}
		}else{
			//继续本分支	//注意第一手是[0]			
			//取黑白						
			let colorObj = this.getColorByNode(this.qsgo.currentTree.nodes[this.qsgo.currentStep -1]) 			
			let currentAct = (colorObj.color == this.qsgo.guessPlayer) ? 'guess' : 'play'
			let currentVertex = this.getVertexByStep(this.qsgo.currentTree,this.qsgo.currentStep -1)		

			//对于存在多分支的情况，guess命令发送 树的分支必须处在第一个节点上，树中间不能有分支
			if(currentAct=='guess' && this.qsgo.currentVertexOptions!=''){
				currentVertex = this.qsgo.currentVertexOptions
			}
			
			//给gtp引擎发命令	
    		let response = await this.sendGtpCommand(currentAct,colorObj,currentVertex)  
    		if(!response.error){
    			//同步棋盘显示 
				//this.setCurrentTreePosition(this.state.currentTree,this.state.currentStep) //当前步数会跳，不知为何？？？
				//await this.waitForRender()	
				
				//获取qsboard返回的坐标，切换到该分支				
				if(this.qsgo.currentVertexOptions != ''){
					//"E19,W17,C18,D18".indexOf("D18") 
					//"E9,W7,C8,D18"  注意这种情况，有三位数和四位数之分	
					let vertexArray = this.qsgo.currentVertexOptions.split(",") 
					let index = vertexArray.indexOf(response.content)
					
					this.qsgo.currentTree = this.qsgo.currentBrotherTrees[index]//切记！！！当前树切换为兄弟树，父亲树无需改变
					if(index > 0){
						this.qsgo.exerciseResult = 'E' 
					}else{
						this.qsgo.exerciseResult = 'R' //除了0分支，其它都认为是错误答案
					}				
					this.qsgo.currentVertexOptions = ''
				}				
				
	    		setTimeout(() => {
	                this.playExerciseStep()
	            }, setting.get('gtp.move_delay'))
    		}
		}
	}

	

    /////////////////////////////////////////////

   

    updateSettingState(key = null) {
        let data = {
            'app.zoom_factor': 'zoomFactor',
            'view.show_menubar': 'showMenuBar',
            'view.show_coordinates': 'showCoordinates',
            'view.show_move_colorization': 'showMoveColorization',
            'view.show_next_moves': 'showNextMoves',
            'view.show_siblings': 'showSiblings',
            'view.fuzzy_stone_placement': 'fuzzyStonePlacement',
            'view.animated_stone_placement': 'animatedStonePlacement',
            'graph.grid_size': 'graphGridSize',
            'graph.node_size': 'graphNodeSize',
            'engines.list': 'engines',
            'scoring.method': 'scoringMethod'
        }

        if (key == null) {
            for (let k in data) this.updateSettingState(k)
            return
        }        

        if (key in data) {
            ipcRenderer.send('build-menu', this.state.busy > 0)
            this.setState({[data[key]]: setting.get(key)})
        }
    }

    waitForRender() {
        return new Promise(resolve => this.setState({}, resolve))
    }

    // User Interface

    setSidebarWidth(sidebarWidth) {
        this.setState({sidebarWidth}, () => window.dispatchEvent(new Event('resize')))
    }

    setLeftSidebarWidth(leftSidebarWidth) {
        this.setState({leftSidebarWidth}, () => window.dispatchEvent(new Event('resize')))
    }

    setMode(mode) {
        let stateChange = {mode}

        if (['scoring', 'estimator'].includes(mode)) {
            // Guess dead stones

            let {treePosition} = this.state
            let iterations = setting.get('score.estimator_iterations')
            let deadStones = deadstones.guess(gametree.getBoard(...treePosition).arrangement, {
                finished: mode === 'scoring',
                iterations
            })

            Object.assign(stateChange, {deadStones})
        }

        this.setState(stateChange)
        this.events.emit('modeChange')
    }

    openDrawer(drawer) {
        this.setState({openDrawer: drawer})
    }

    closeDrawer() {
        this.openDrawer(null)
    }

    setBusy(busy) {
        let diff = busy ? 1 : -1;
        this.setState(s => ({busy: Math.max(s.busy + diff, 0)}))
    }

    showInfoOverlay(text) {
        this.setState({
            infoOverlayText: text,
            showInfoOverlay: true
        })
    }

    hideInfoOverlay() {
        this.setState({showInfoOverlay: false})
    }

    flashInfoOverlay(text) {
        this.showInfoOverlay(text)
        setTimeout(() => this.hideInfoOverlay(), setting.get('infooverlay.duration'))
    }

    clearConsole() {
        this.setState({consoleLog: []})
    }

    // File Management

    getEmptyGameTree() {
        let handicap = 0 //setting.get('game.default_handicap') //不要每次都取上次的让子,否则远程通讯开局时会沿用上一局的让子
        let size = setting.get('game.default_board_size').toString().split(':').map(x => +x)
        let [width, height] = [size[0], size.slice(-1)[0]]
        let handicapStones = new Board(width, height).getHandicapPlacement(handicap).map(sgf.vertex2point)

        let sizeInfo = width === height ? width.toString() : `${width}:${height}`
        let handicapInfo = handicapStones.length > 0 ? `HA[${handicap}]AB[${handicapStones.join('][')}]` : ''
        let date = new Date()
        let dateInfo = sgf.dates2string([[date.getFullYear(), date.getMonth() + 1, date.getDate()]])

        return sgf.parse(`
            (;GM[1]FF[4]CA[UTF-8]AP[${this.appName}:${this.version}]
            KM[${setting.get('game.default_komi')}]
            SZ[${sizeInfo}]DT[${dateInfo}]
            ${handicapInfo})
        `)[0]
    }

    async newFile({playSound = false, showInfo = false, suppressAskForSave = false} = {}) {
     
        if (!suppressAskForSave && !this.askForSave()) return

        if (showInfo && this.state.openDrawer === 'info') this.closeDrawer()
        this.setMode('play')

        this.clearUndoPoint()
        this.detachEngines()
        this.clearConsole()

        this.state.showCommentBox = false//added by xiarx 下棋时关掉注解页面
        this.state.showGameGraph = false//added by xiarx 下棋时关掉树页面
        this.qsgo.gameOverFlag = false //added by xiarx 棋局终了标志
        this.qsgo.currentAction = 'NewFile' //added by xiarx 当前执行菜单

        await this.waitForRender()

        let emptyTree = this.getEmptyGameTree()

        this.setState({
            openDrawer: showInfo ? 'info' : null,
            gameTrees: [emptyTree],
            representedFilename: null
        })

        this.setCurrentTreePosition(emptyTree, 0)

        this.treeHash = this.generateTreeHash()
        this.fileHash = this.generateFileHash()

        if (playSound) sound.playNewGame()
    }

    async loadFile(filename = null, {suppressAskForSave = false} = {}) {
    	
    	//debugger //增加复盘功能时，对棋思智能棋盘gtp server 的驱动
    	this.qsgo.currentAction = 'loadFile' //added by xiarx 当前执行菜单 主要用于让子棋的

        if (!suppressAskForSave && !this.askForSave()) return

        if (!filename) {
            dialog.showOpenDialog({
                properties: ['openFile'],
                filters: [...fileformats.meta, {name: 'All Files', extensions: ['*']}]
            }, ({result}) => {
                if (result) filename = result[0]
                //if (filename) this.loadFile(filename, {suppressAskForSave: true})
                if (filename) {
                    this.loadFile(filename, {suppressAskForSave: true})        
                    ///////////////////////////////////////////            
                    this.state.showCommentBox = true//added by xiarx 复盘时自动打开注解页面
                    this.state.showGameGraph = true//added by xiarx 复盘自动打开树页面
                    this.qsgo.gameOverFlag = false//added by xiarx 复盘时允许鼠标点击
                    ///////////////////////////////////////////
                }
            })

            return
        }

        let {extname} = require('path')
        let extension = extname(filename).slice(1)
        let content = fs.readFileSync(filename, {encoding: 'binary'})

        let success = await this.loadContent(content, extension, {suppressAskForSave: true})

        if (success) {
            this.setState({representedFilename: filename})
            this.fileHash = this.generateFileHash()

            if (setting.get('game.goto_end_after_loading')) {
                this.goToEnd()
            }
           
        }
    }    

    async loadContent(content, extension, {suppressAskForSave = false, ignoreEncoding = false} = {}) {

        if (!suppressAskForSave && !this.askForSave()) return

        this.setBusy(true)
        if (this.state.openDrawer !== 'gamechooser') this.closeDrawer()
        this.setMode('play')

        await helper.wait(setting.get('app.loadgame_delay'))

        let lastProgress = -1
        let success = true
        let gameTrees = []

        try {
            let fileFormatModule = fileformats.getModuleByExtension(extension)

            gameTrees = fileFormatModule.parse(content, evt => {
                if (evt.progress - lastProgress < 0.1) return
                this.window.setProgressBar(evt.progress)
                lastProgress = evt.progress
            }, ignoreEncoding)

            if (gameTrees.length == 0) throw true
        } catch (err) {
            dialog.showMessageBox('亲，该文件可能不是一个合法的存盘文件，请检查一下哦！', 'warning')
            success = false
        }

        if (gameTrees.length != 0) {
            this.clearUndoPoint()
            this.detachEngines()
            this.setState({
                representedFilename: null,
                gameTrees
            })

            this.setCurrentTreePosition(gameTrees[0], 0)

            await sabaki.waitForRender()//added by xiarx 
            this.treeHash = this.generateTreeHash()
            this.fileHash = this.generateFileHash()
        }

        this.setBusy(false)

        if (gameTrees.length > 1) {
            setTimeout(() => {
                this.openDrawer('gamechooser')
            }, setting.get('gamechooser.show_delay'))
        }

        this.window.setProgressBar(-1)

        if (success) this.events.emit('fileLoad')
        return success
    }

    saveFile(filename = null) {
    	
        if (!filename) {
            let cancel = false

            dialog.showSaveDialog({
                filters: [sgf.meta, {name: 'All Files', extensions: ['*']}]
            }, ({result}) => {
                if (result) this.saveFile(result)
                cancel = !result
            })

            return !cancel
        }

        this.setBusy(true)
        fs.writeFileSync(filename, this.getSGF())

        this.setBusy(false)
        this.setState({representedFilename: filename})

        this.treeHash = this.generateTreeHash()
        this.fileHash = this.generateFileHash()

        return true
    }

    getSGF() {
        let {gameTrees} = this.state

        for (let tree of gameTrees) {
            Object.assign(tree.nodes[0], {
                AP: [`${this.appName}:${this.version}`],
                CA: ['UTF-8']
            })
        }

        return sgf.stringify(gameTrees)
    }

    generateTreeHash() {
        return this.state.gameTrees.map(tree => gametree.getHash(tree)).join('')
    }

    generateFileHash() {
        let {representedFilename} = this.state
        if (!representedFilename) return null

        try {
            let content = fs.readFileSync(representedFilename, 'utf8')
            return helper.hash(content)
        } catch (err) {}

        return null
    }

    askForSave() {
        let hash = this.generateTreeHash()

        if (hash !== this.treeHash) {
            let answer = dialog.showMessageBox(
                '是否保存当前棋局？',
                'warning',
                ['保存', '不保存', '取消'], 2
            )

            if (answer === 0) return this.saveFile(this.state.representedFilename)
            else if (answer === 2) return false
        }

        return true
    }

    askForReload() {
        let hash = this.generateFileHash()

        if (hash != null && hash !== this.fileHash) {
            let answer = dialog.showMessageBox([
                `This file has been changed outside of ${this.appName}.`,
                'Do you want to reload the file? Your changes will be lost.'
            ].join('\n'), 'warning', ['Reload', 'Don’t Reload'], 1)

            if (answer === 0) {
                this.loadFile(this.state.representedFilename, {suppressAskForSave: true})
            } else {
                this.treeHash = null
            }

            this.fileHash = hash
        }
    }

    // Playing

    clickVertex(vertex, {button = 0, ctrlKey = false, x = 0, y = 0} = {}) {
        this.closeDrawer()

        if(this.qsgo.gameOverFlag) renturn 

        let [tree, index] = this.state.treePosition
        let board = gametree.getBoard(tree, index)
        let node = tree.nodes[index]

        if (typeof vertex == 'string') {
            vertex = board.coord2vertex(vertex)
        }

        if (['play', 'autoplay'].includes(this.state.mode)) {
            if (button === 0) {
                if (board.get(vertex) === 0) {

                	//GTP引擎的回合拒绝接受鼠标点击 xiarx          
                	let player = this.inferredState.currentPlayer //黑方 1 白方 -1        			
        			if (player > 0) {       
                        if(this.attachedEngineControllers[0]) return 
        			}else{        
                        if(this.attachedEngineControllers[1]) return 
        			}
        			///////////////////////////////////////////

                    this.makeMove(vertex, {sendToEngine: true})

                } else if (vertex in board.markups
                && board.markups[vertex][0] === 'point'
                && setting.get('edit.click_currentvertex_to_remove')) {
                    this.removeNode(tree, index)
                }
            } else if (button === 2) {
                if (vertex in board.markups && board.markups[vertex][0] === 'point') {
                    this.openCommentMenu(tree, index, {x, y})
                }
            }
        } else if (this.state.mode === 'edit') {
            if (ctrlKey) {
                // Add coordinates to comment
                let coord = board.vertex2coord(vertex)
                let commentText = node.C ? node.C[0] : ''

                node.C = commentText !== '' ? [commentText.trim() + ' ' + coord] : [coord]
                return
            }

            let tool = this.state.selectedTool

            if (button === 2) {
                // Right mouse click

                if (['stone_1', 'stone_-1'].includes(tool)) {
                    // Switch stone tool

                    tool = tool === 'stone_1' ? 'stone_-1' : 'stone_1'
                } else if (['number', 'label'].includes(tool)) {
                    // Show label editing context menu

                    let click = () => dialog.showInputBox('Enter label text', ({value}) => {
                        this.useTool('label', vertex, value)
                    })

                    let template = [{label: '&Edit Label', click}]
                    helper.popupMenu(template, x, y)

                    return
                }
            }

            if (['line', 'arrow'].includes(tool)) {
                // Remember clicked vertex and pass as an argument the second time

                if (!this.editVertexData || this.editVertexData[0] !== tool) {
                    this.useTool(tool, vertex)
                    this.editVertexData = [tool, vertex]
                } else {
                    this.useTool(tool, vertex, this.editVertexData[1])
                    this.editVertexData = null
                }
            } else {
                this.useTool(tool, vertex)
                this.editVertexData = null
            }
        } else if (['scoring', 'estimator'].includes(this.state.mode)) {
            if (button !== 0 || board.get(vertex) === 0) return

            let {mode, deadStones} = this.state
            let dead = deadStones.some(v => helper.vertexEquals(v, vertex))
            let stones = mode === 'estimator' ? board.getChain(vertex) : board.getRelatedChains(vertex)

            if (!dead) {
                deadStones = [...deadStones, ...stones]
            } else {
                deadStones = deadStones.filter(v => !stones.some(w => helper.vertexEquals(v, w)))
            }

            this.setState({deadStones})
        } else if (this.state.mode === 'find') {
            if (button !== 0) return

            if (helper.vertexEquals(this.state.findVertex || [-1, -1], vertex)) {
                this.setState({findVertex: null})
            } else {
                this.setState({findVertex: vertex})
                this.findMove(1, {vertex, text: this.state.findText})
            }
        } else if (this.state.mode === 'guess') {
            if (button !== 0) return

            let tp = gametree.navigate(...this.state.treePosition, 1)
            if (!tp) return this.setMode('play')

            let nextNode = tp[0].nodes[tp[1]]
            if (!('B' in nextNode || 'W' in nextNode)) return this.setMode('play')

            let nextVertex = sgf.point2vertex(nextNode['B' in nextNode ? 'B' : 'W'][0])
            let board = gametree.getBoard(...this.state.treePosition)
            if (!board.hasVertex(nextVertex)) return this.setMode('play')

            if (helper.vertexEquals(vertex, nextVertex)) {
                this.makeMove(vertex, {player: 'B' in nextNode ? 1 : -1})
            } else {
                if (board.get(vertex) !== 0
                || this.state.blockedGuesses.some(v => helper.vertexEquals(v, vertex)))
                    return

                let blocked = []
                let [, i] = vertex.map((x, i) => Math.abs(x - nextVertex[i]))
                    .reduce(([max, i], x, j) => x > max ? [x, j] : [max, i], [-Infinity, -1])

                for (let x = 0; x < board.width; x++) {
                    for (let y = 0; y < board.height; y++) {
                        let z = i === 0 ? x : y
                        if (Math.abs(z - vertex[i]) < Math.abs(z - nextVertex[i]))
                            blocked.push([x, y])
                    }
                }

                let {blockedGuesses} = this.state
                blockedGuesses.push(...blocked)
                this.setState({blockedGuesses})
            }
        }

        this.events.emit('vertexClick')
    }

    makeMove(vertex, {player = null, clearUndoPoint = true, sendToEngine = false} = {}) {    	

        if (!['play', 'autoplay', 'guess'].includes(this.state.mode)) {
            this.closeDrawer()
            this.setMode('play')
        }

        let [tree, index] = this.state.treePosition
        let board = gametree.getBoard(tree, index)

        if (typeof vertex == 'string') {
            vertex = board.coord2vertex(vertex)
        }

        let pass = !board.hasVertex(vertex)
        if (!pass && board.get(vertex) !== 0) return

        let prev = gametree.navigate(tree, index, -1)
        if (!player) player = this.inferredState.currentPlayer
        let color = player > 0 ? 'B' : 'W'
        let capture = false, suicide = false, ko = false
        let createNode = true

        if (!pass) {
            // Check for ko

            if (prev && setting.get('game.show_ko_warning')) {
                let hash = board.makeMove(player, vertex).getPositionHash()

                ko = prev[0].nodes[prev[1]].board.getPositionHash() == hash

                //打劫的情况 xiarx
                if (ko) {
                	dialog.showMessageBox(
	                    ['对不起，您不能在没有寻劫的情况下直接提劫，',
	                    '请在别处落子！'].join('\n'),
	                    'info',
	                    ['返回'], 0
                	) 
                	return
                } 
                /*
                if (ko && dialog.showMessageBox(
                    ['You are about to play a move which repeats a previous board position.',
                    'This is invalid in some rulesets.'].join('\n'),
                    'info',
                    ['Play Anyway', 'Don’t Play'], 1
                ) != 0) return
                */
            }

            let vertexNeighbors = board.getNeighbors(vertex)

            // Check for suicide

            capture = vertexNeighbors
                .some(v => board.get(v) == -player && board.getLiberties(v).length == 1)

            suicide = !capture
            && vertexNeighbors.filter(v => board.get(v) == player)
                .every(v => board.getLiberties(v).length == 1)
            && vertexNeighbors.filter(v => board.get(v) == 0).length == 0

            //自杀的情况  xiarx
            if (suicide) {
            	dialog.showMessageBox(
                    ['对不起，按照规则您不能没气的地方落子，',
                    '请在别处落子！'].join('\n'),
                    'info',
                    ['返回'], 0
            	) 
            	return
            } 
            /*
            if (suicide && setting.get('game.show_suicide_warning')) {
                if (dialog.showMessageBox(
                    ['You are about to play a suicide move.',
                    'This is invalid in some rulesets.'].join('\n'),
                    'info',
                    ['Play Anyway', 'Don’t Play'], 1
                ) != 0) return
            }
            */

            // Animate board

            this.setState({animatedVertex: vertex})
        }

        // Update data

        let nextTreePosition

        if (tree.subtrees.length === 0 && tree.nodes.length - 1 === index) {
            // Append move

            let node = {}
            node[color] = [sgf.vertex2point(vertex)]
            tree.nodes.push(node)

            nextTreePosition = [tree, tree.nodes.length - 1]
        } else {
            if (index !== tree.nodes.length - 1) {
                // Search for next move

                let nextNode = tree.nodes[index + 1]
                let moveExists = color in nextNode
                    && helper.vertexEquals(sgf.point2vertex(nextNode[color][0]), vertex)

                if (moveExists) {
                    nextTreePosition = [tree, index + 1]
                    createNode = false
                }
            } else {
                // Search for variation

                let variations = tree.subtrees.filter(subtree => {
                    return subtree.nodes.length > 0
                        && color in subtree.nodes[0]
                        && helper.vertexEquals(sgf.point2vertex(subtree.nodes[0][color][0]), vertex)
                })

                if (variations.length > 0) {
                    nextTreePosition = [variations[0], 0]
                    createNode = false
                }
            }

            if (createNode) {
                // Create variation

                let updateRoot = tree.parent == null
                let splitted = gametree.split(tree, index)
                let newTree = gametree.new()
                let node = {[color]: [sgf.vertex2point(vertex)]}

                newTree.nodes = [node]
                newTree.parent = splitted

                splitted.subtrees.push(newTree)
                splitted.current = splitted.subtrees.length - 1

                if (updateRoot) {
                    let {gameTrees} = this.state
                    gameTrees[gameTrees.indexOf(tree)] = splitted
                }

                nextTreePosition = [newTree, 0]
            }
        }

        this.setCurrentTreePosition(...nextTreePosition)

        // Play sounds

        if (!pass) {
            let delay = setting.get('sound.capture_delay_min')
            delay += Math.floor(Math.random() * (setting.get('sound.capture_delay_max') - delay))

            if (capture || suicide)
                sound.playCapture(delay)

            sound.playPachi()
        } else {
            sound.playPass()
        }

        // Clear undo point

        if (createNode && clearUndoPoint) this.clearUndoPoint()

        // Enter scoring mode after two consecutive passes

        let enterScoring = false

        if (pass && createNode && prev) {
            let prevNode = tree.nodes[index]
            let prevColor = color === 'B' ? 'W' : 'B'
            let prevPass = prevColor in prevNode && prevNode[prevColor][0] === ''

            if (prevPass) {
                enterScoring = true
                this.setMode('scoring')
            }
        }

        // Emit event

        this.events.emit('moveMake', {pass, capture, suicide, ko, enterScoring})

        // Send command to engine

        if (sendToEngine && this.attachedEngineControllers.some(x => x != null)) {
            let passPlayer = pass ? player : null
            setTimeout(() => this.startGeneratingMoves({passPlayer}), setting.get('gtp.move_delay'))
        }
    }

    makeResign({player = null, setUndoPoint = true} = {}) {
        let {rootTree, currentPlayer} = this.inferredState
        if (player == null) player = currentPlayer
        let color = player > 0 ? 'W' : 'B'
        let rootNode = rootTree.nodes[0]

        if (setUndoPoint) this.setUndoPoint('Undo Resignation')
        rootNode.RE = [`${color}+Resign`]

        this.makeMove([-1, -1], {player, clearUndoPoint: false})
        this.makeMainVariation(...this.state.treePosition, {setUndoPoint: false})

        //this.setBusy(false)//xiarx added 20180408
        //此处需要修改，棋局结束后，应该不能再在棋盘上落子
        this.qsgo.gameOverFlag = true
        /////////////////////////////////////////

        this.events.emit('resign', {player})
        
    }

    useTool(tool, vertex, argument = null) {
        let [tree, index] = this.state.treePosition
        let {currentPlayer, gameIndex} = this.inferredState
        let board = gametree.getBoard(tree, index)
        let node = tree.nodes[index]

        if (typeof vertex == 'string') {
            vertex = board.coord2vertex(vertex)
        }

        let data = {
            cross: 'MA',
            triangle: 'TR',
            circle: 'CR',
            square: 'SQ',
            number: 'LB',
            label: 'LB'
        }

        if (['stone_-1', 'stone_1'].includes(tool)) {
            if ('B' in node || 'W' in node || gametree.navigate(tree, index, 1)) {
                // New variation needed

                let updateRoot = tree.parent == null
                let splitted = gametree.split(tree, index)

                if (splitted != tree || splitted.subtrees.length != 0) {
                    tree = gametree.new()
                    tree.parent = splitted
                    splitted.subtrees.push(tree)
                }

                node = {PL: currentPlayer > 0 ? ['B'] : ['W']}
                index = tree.nodes.length
                tree.nodes.push(node)

                if (updateRoot) {
                    let {gameTrees} = this.state
                    gameTrees[gameIndex] = splitted
                }
            }

            let sign = tool === 'stone_1' ? 1 : -1
            let oldSign = board.get(vertex)
            let properties = ['AW', 'AE', 'AB']
            let point = sgf.vertex2point(vertex)

            for (let prop of properties) {
                if (!(prop in node)) continue

                // Resolve compressed lists

                if (node[prop].some(x => x.includes(':'))) {
                    node[prop] = node[prop]
                        .map(value => sgf.compressed2list(value).map(sgf.vertex2point))
                        .reduce((list, x) => [...list, x])
                }

                // Remove residue

                node[prop] = node[prop].filter(x => x !== point)
                if (node[prop].length === 0) delete node[prop]
            }

            let prop = oldSign !== sign ? properties[sign + 1] : 'AE'

            if (prop in node) node[prop].push(point)
            else node[prop] = [point]
        } else if (['line', 'arrow'].includes(tool)) {
            let endVertex = argument

            if (!endVertex || helper.vertexEquals(vertex, endVertex)) return

            // Check whether to remove a line

            let toDelete = board.lines.findIndex(x => helper.equals(x.slice(0, 2), [vertex, endVertex]))

            if (toDelete === -1) {
                toDelete = board.lines.findIndex(x => helper.equals(x.slice(0, 2), [endVertex, vertex]))

                if (toDelete >= 0 && tool !== 'line' && board.lines[toDelete][2]) {
                    // Do not delete after all
                    toDelete = -1
                }
            }

            // Mutate board first, then apply changes to actual game tree

            if (toDelete >= 0) {
                board.lines.splice(toDelete, 1)
            } else {
                board.lines.push([vertex, endVertex, tool === 'arrow'])
            }

            node.LN = []
            node.AR = []

            for (let [v1, v2, arrow] of board.lines) {
                let [p1, p2] = [v1, v2].map(sgf.vertex2point)
                if (p1 === p2) continue

                node[arrow ? 'AR' : 'LN'].push([p1, p2].join(':'))
            }

            if (node.LN.length === 0) delete node.LN
            if (node.AR.length === 0) delete node.AR
        } else {
            // Mutate board first, then apply changes to actual game tree

            if (tool === 'number') {
                if (vertex in board.markups && board.markups[vertex][0] === 'label') {
                    delete board.markups[vertex]
                } else {
                    let number = !node.LB ? 1 : node.LB
                        .map(x => parseFloat(x.substr(3)))
                        .filter(x => !isNaN(x))
                        .sort((a, b) => a - b)
                        .filter((x, i, arr) => i === 0 || x !== arr[i - 1])
                        .concat([null])
                        .findIndex((x, i) => i + 1 !== x) + 1

                    argument = number.toString()
                    board.markups[vertex] = [tool, number.toString()]
                }
            } else if (tool === 'label') {
                let label = argument

                if (label != null && label.trim() === ''
                || label == null && vertex in board.markups && board.markups[vertex][0] === 'label') {
                    delete board.markups[vertex]
                } else {
                    if (label == null) {
                        let alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
                        let letterIndex = Math.max(
                            !node.LB ? 0 : node.LB
                                .filter(x => x.length === 4)
                                .map(x => alpha.indexOf(x[3]))
                                .filter(x => x >= 0)
                                .sort((a, b) => a - b)
                                .filter((x, i, arr) => i === 0 || x !== arr[i - 1])
                                .concat([null])
                                .findIndex((x, i) => i !== x),
                            !node.L ? 0 : node.L.length
                        )

                        label = alpha[Math.min(letterIndex, alpha.length - 1)]
                        argument = label
                    }

                    board.markups[vertex] = [tool, label]
                }
            } else {
                if (vertex in board.markups && board.markups[vertex][0] === tool) {
                    delete board.markups[vertex]
                } else {
                    board.markups[vertex] = [tool, '']
                }
            }

            delete node.L
            for (let id in data) delete node[data[id]]

            // Now apply changes to game tree

            for (let x = 0; x < board.width; x++) {
                for (let y = 0; y < board.height; y++) {
                    let v = [x, y]
                    if (!(v in board.markups)) continue

                    let prop = data[board.markups[v][0]]
                    let value = sgf.vertex2point(v)

                    if (prop === 'LB')
                        value += ':' + board.markups[v][1]

                    if (prop in node) node[prop].push(value)
                    else node[prop] = [value]
                }
            }
        }

        this.clearUndoPoint()
        this.setCurrentTreePosition(tree, index)

        this.events.emit('toolUse', {tool, vertex, argument})
    }

    // Undo Methods

    setUndoPoint(undoText = 'Undo') {
        let {treePosition: [tree, index]} = this.state
        let rootTree = gametree.clone(gametree.getRoot(tree))
        let level = gametree.getLevel(tree, index)

        this.undoData = [rootTree, level]
        this.setState({undoable: true, undoText})
    }

    clearUndoPoint() {
        this.undoData = null
        this.setState({undoable: false})
    }

    undo() {
        if (!this.state.undoable || !this.undoData) return

        this.setBusy(true)

        setTimeout(() => {
            let [undoRoot, undoLevel] = this.undoData
            let {treePosition, gameTrees} = this.state

            gameTrees[this.inferredState.gameIndex] = undoRoot
            treePosition = gametree.navigate(undoRoot, 0, undoLevel)

            this.setCurrentTreePosition(...treePosition)
            this.clearUndoPoint()
            this.setBusy(false)
        }, setting.get('edit.undo_delay'))
    }

    // Navigation

    setCurrentTreePosition(tree, index, {clearUndoPoint = true} = {}) { 
        if (['scoring', 'estimator'].includes(this.state.mode))
            return

        let t = tree
        while (t.parent != null) {
            t.parent.current = t.parent.subtrees.indexOf(t)
            t = t.parent
        }

        if (clearUndoPoint && t !== gametree.getRoot(this.state.treePosition[0])) {
            this.clearUndoPoint()
        }

        this.setState({
            heatMap: null,
            blockedGuesses: [],
            highlightVertices: [],
            treePosition: [tree, index]
        })

        this.events.emit('navigate')
    }

    goStep(step) {
        let treePosition = gametree.navigate(...this.state.treePosition, step)
        if (treePosition) this.setCurrentTreePosition(...treePosition)
    }

    goToMoveNumber(number) {
        number = +number

        if (isNaN(number)) return
        if (number < 0) number = 0

        let {treePosition} = this.state
        let root = gametree.getRoot(...treePosition)

        treePosition = gametree.navigate(root, 0, Math.round(number))

        if (treePosition) this.setCurrentTreePosition(...treePosition)
        else this.goToEnd()
    }

    goToNextFork() {
        let [tree, index] = this.state.treePosition

        if (index !== tree.nodes.length - 1) {
            this.setCurrentTreePosition(tree, tree.nodes.length - 1)
        } else if (tree.subtrees.length !== 0) {
            let subtree = tree.subtrees[tree.current]
            this.setCurrentTreePosition(subtree, subtree.nodes.length - 1)
        }
    }

    goToPreviousFork() {
        let [tree, index] = this.state.treePosition

        if (tree.parent == null || tree.parent.nodes.length === 0) {
            if (index != 0) this.setCurrentTreePosition(tree, 0)
        } else {
            this.setCurrentTreePosition(tree.parent, tree.parent.nodes.length - 1)
        }
    }

    goToComment(step) {
        let tp = this.state.treePosition

        while (true) {
            tp = gametree.navigate(...tp, step)
            if (!tp) break

            let node = tp[0].nodes[tp[1]]

            if (setting.get('sgf.comment_properties').some(p => p in node))
                break
        }

        if (tp) this.setCurrentTreePosition(...tp)
    }

    goToBeginning() {
        this.setCurrentTreePosition(gametree.getRoot(...this.state.treePosition), 0)
    }

    goToEnd() {
        let rootTree = gametree.getRoot(...this.state.treePosition)
        let tp = gametree.navigate(rootTree, 0, gametree.getCurrentHeight(rootTree) - 1)
        this.setCurrentTreePosition(...tp)
    }

    goToSiblingVariation(step) {
        let [tree, index] = this.state.treePosition
        if (!tree.parent) return

        step = step < 0 ? -1 : 1

        let mod = tree.parent.subtrees.length
        let i = (tree.parent.current + mod + step) % mod

        this.setCurrentTreePosition(tree.parent.subtrees[i], 0)
    }

    goToMainVariation() {
        let tp = this.state.treePosition
        let root = gametree.getRoot(...tp)

        while (root.subtrees.length !== 0) {
            root.current = 0
            root = root.subtrees[0]
        }

        if (gametree.onMainTrack(...tp)) {
            this.setCurrentTreePosition(...tp)
        } else {
            let [tree] = tp

            while (!gametree.onMainTrack(tree)) {
                tree = tree.parent
            }

            this.setCurrentTreePosition(tree, tree.nodes.length - 1)
        }
    }

    goToSiblingGame(step) {
        let {gameTrees, treePosition} = this.state
        let [tree, ] = treePosition
        let index = gameTrees.indexOf(gametree.getRoot(tree))
        let newIndex = Math.max(0, Math.min(gameTrees.length - 1, index + step))

        this.setCurrentTreePosition(gameTrees[newIndex], 0)
    }

    // Find Methods

    async findPosition(step, condition) {
        if (isNaN(step)) step = 1
        else step = step >= 0 ? 1 : -1

        this.setBusy(true)

        await helper.wait(setting.get('find.delay'))

        let tp = this.state.treePosition
        let iterator = gametree.makeHorizontalNavigator(...tp)

        while (true) {
            tp = step >= 0 ? iterator.next() : iterator.prev()

            if (!tp) {
                let root = this.inferredState.rootTree

                if (step === 1) {
                    tp = [root, 0]
                } else {
                    let sections = gametree.getSection(root, gametree.getHeight(root) - 1)
                    tp = sections[sections.length - 1]
                }

                iterator = gametree.makeHorizontalNavigator(...tp)
            }

            if (helper.vertexEquals(tp, this.state.treePosition) || condition(...tp))
                break
        }

        this.setCurrentTreePosition(...tp)
        this.setBusy(false)
    }

    async findHotspot(step) {
        await this.findPosition(step, (tree, index) => 'HO' in tree.nodes[index])
    }

    async findMove(step, {vertex = null, text = ''}) {
        if (vertex == null && text.trim() === '') return
        let point = vertex ? sgf.vertex2point(vertex) : null

        await this.findPosition(step, (tree, index) => {
            let node = tree.nodes[index]
            let cond = (prop, value) => prop in node
                && node[prop][0].toLowerCase().includes(value.toLowerCase())

            return (!point || ['B', 'W'].some(x => cond(x, point)))
                && (!text || cond('C', text) || cond('N', text))
        })
    }

    // Node Actions

    getGameInfo(tree) {
        let root = gametree.getRoot(tree)

        let komi = gametree.getRootProperty(root, 'KM')
        if (komi != null && !isNaN(komi)) komi = +komi
        else komi = null

        let size = gametree.getRootProperty(root, 'SZ')
        if (size == null) {
            size = [19, 19]
        } else {
            let s = size.toString().split(':')
            size = [+s[0], +s[s.length - 1]]
        }

        let handicap = ~~gametree.getRootProperty(root, 'HA', 0)
        handicap = Math.max(1, Math.min(9, handicap))
        if (handicap === 1) handicap = 0

        let playerNames = ['B', 'W'].map(x =>
            gametree.getRootProperty(tree, `P${x}`) || gametree.getRootProperty(tree, `${x}T`)
        )

        let playerRanks = ['BR', 'WR'].map(x => gametree.getRootProperty(root, x))

        return {
            playerNames,
            playerRanks,
            blackName: playerNames[0],
            blackRank: playerRanks[0],
            whiteName: playerNames[1],
            whiteRank: playerRanks[1],
            gameName: gametree.getRootProperty(root, 'GN'),
            eventName: gametree.getRootProperty(root, 'EV'),
            date: gametree.getRootProperty(root, 'DT'),
            result: gametree.getRootProperty(root, 'RE'),
            komi,
            handicap,
            size
        }
    }

    setGameInfo(tree, data) {     
        let root = gametree.getRoot(tree)
        let node = root.nodes[0]

        if ('size' in data) {
            // Update board size

            if (data.size) {
                let value = data.size
                value = value.map((x, i) => isNaN(x) || !x ? 19 : Math.min(25, Math.max(2, x)))

                if (value[0] === value[1]) value = value[0]
                else value = value.join(':')

                setting.set('game.default_board_size', value)
                node.SZ = [value]
            } else {
                delete node.SZ
            }
        }

        let props = {
            blackName: 'PB',
            blackRank: 'BR',
            whiteName: 'PW',
            whiteRank: 'WR',
            gameName: 'GN',
            eventName: 'EV',
            date: 'DT',
            result: 'RE',
            komi: 'KM',
            handicap: 'HA'
        }

        for (let key in props) {
            if (!(key in data)) continue

            let value = data[key]

            if (value && value.toString().trim() !== '') {
                if (key === 'komi') {
                    if (isNaN(value)) value = 0

                    setting.set('game.default_komi', value)
                } else if (key === 'handicap') {
                    let board = gametree.getBoard(root, 0)
                    let stones = board.getHandicapPlacement(+value)
                    value = stones.length
                    setting.set('game.default_handicap', value)                        

                    if (value <= 1) {
                        delete node[props[key]]
                        delete node.AB
                        continue
                    }

                    node.AB = stones.map(sgf.vertex2point)
                }

                node[props[key]] = [value]
            } else {
                delete node[props[key]]
            }
        }
    }

    getPlayer(tree, index) {
        let node = tree.nodes[index]

        return 'PL' in node ? (node.PL[0] == 'W' ? -1 : 1)
            : 'B' in node || 'HA' in node && +node.HA[0] >= 1 ? -1
            : 1
    }

    setPlayer(tree, index, sign) {
        let node = tree.nodes[index]
        let intendedSign = 'B' in node || 'HA' in node && +node.HA[0] >= 1 ? -1 : +('W' in node)

        if (intendedSign === sign || sign === 0) {
            delete node.PL
        } else {
            node.PL = [sign > 0 ? 'B' : 'W']
        }

        this.clearUndoPoint()
    }

    getComment(tree, index) {
        let node = tree.nodes[index]

        return {
            title: 'N' in node ? node.N[0].trim() : null,
            comment: 'C' in node ? node.C[0] : null,
            hotspot: 'HO' in node,
            moveAnnotation: 'BM' in node ? 'BM'
                : 'TE' in node ? 'TE'
                : 'DO' in node ? 'DO'
                : 'IT' in node ? 'IT'
                : null,
            positionAnnotation: 'UC' in node ? 'UC'
                : 'GW' in node ? 'GW'
                : 'DM' in node ? 'DM'
                : 'GB' in node ? 'GB'
                : null
        }
    }

    setComment(tree, index, data) {
        let node = tree.nodes[index]

        for (let [key, prop] of [['title', 'N'], ['comment', 'C']]) {
            if (key in data) {
                if (data[key] && data[key].trim() !== '') node[prop] = [data[key]]
                else delete node[prop]
            }
        }

        if ('hotspot' in data) {
            if (data.hotspot) node.HO = [1]
            else delete node.HO
        }

        let clearProperties = properties => properties.forEach(p => delete node[p])

        if ('moveAnnotation' in data) {
            let moveProps = {'BM': 1, 'DO': '', 'IT': '', 'TE': 1}

            clearProperties(Object.keys(moveProps))

            if (data.moveAnnotation != null)
                node[data.moveAnnotation] = [moveProps[data.moveAnnotation]]
        }

        if ('positionAnnotation' in data) {
            let positionProps = {'UC': 1, 'GW': 1, 'GB': 1, 'DM': 1}

            clearProperties(Object.keys(positionProps))

            if (data.positionAnnotation != null)
                node[data.positionAnnotation] = [positionProps[data.positionAnnotation]]
        }

        this.clearUndoPoint()
    }

    copyVariation(tree, index) {
        let clone = gametree.clone(tree)
        if (index != 0) gametree.split(clone, index - 1)

        this.copyVariationData = clone
    }

    cutVariation(tree, index, {setUndoPoint = true} = {}) {
        if (setUndoPoint) this.setUndoPoint('Undo Cut Variation')

        this.copyVariation(tree, index)
        this.removeNode(tree, index, {
            suppressConfirmation: true,
            setUndoPoint: false
        })
    }

    pasteVariation(tree, index, {setUndoPoint = true} = {}) {
        if (this.copyVariationData == null) return

        if (setUndoPoint) this.setUndoPoint('Undo Paste Variation')
        this.closeDrawer()
        this.setMode('play')

        let updateRoot = !tree.parent
        let oldLength = tree.nodes.length
        let splitted = gametree.split(tree, index)
        let copied = gametree.clone(this.copyVariationData)

        copied.parent = splitted
        splitted.subtrees.push(copied)

        if (updateRoot) {
            let {gameTrees} = this.state
            gameTrees[this.inferredState.gameIndex] = splitted
            this.setState({gameTrees})
        }

        if (splitted.subtrees.length === 1) {
            gametree.reduce(splitted)
            this.setCurrentTreePosition(splitted, oldLength)
        } else {
            this.setCurrentTreePosition(copied, 0)
        }
    }

    flattenVariation(tree, index, {setUndoPoint = true} = {}) {
        if (setUndoPoint) this.setUndoPoint('Undo Flatten')
        this.closeDrawer()
        this.setMode('play')

        let {gameTrees} = this.state
        let {rootTree, gameIndex} = this.inferredState
        let board = gametree.getBoard(tree, index)
        let rootNode = rootTree.nodes[0]
        let inherit = ['BR', 'BT', 'DT', 'EV', 'GN', 'GC', 'PB', 'PW', 'RE', 'SO', 'WT', 'WR']

        let clone = gametree.clone(tree)
        if (index !== 0) gametree.split(clone, index - 1)
        let node = clone.nodes[0]

        node.AB = []
        node.AW = []
        delete node.AE
        delete node.B
        delete node.W

        clone.parent = null
        inherit.forEach(x => x in rootNode ? node[x] = rootNode[x] : null)

        for (let x = 0; x < board.width; x++) {
            for (let y = 0; y < board.height; y++) {
                let sign = board.get([x, y])
                if (sign == 0) continue

                node[sign > 0 ? 'AB' : 'AW'].push(sgf.vertex2point([x, y]))
            }
        }

        if (node.AB.length === 0) delete node.AB
        if (node.AW.length === 0) delete node.AW

        gameTrees[gameIndex] = clone
        this.setState({gameTrees})
        this.setCurrentTreePosition(clone, 0, {clearUndoPoint: false})
    }

    makeMainVariation(tree, index, {setUndoPoint = true} = {}) {
        if (setUndoPoint) this.setUndoPoint('Restore Main Variation')
        this.closeDrawer()
        this.setMode('play')

        let t = tree

        while (t.parent != null) {
            t.parent.subtrees.splice(t.parent.subtrees.indexOf(t), 1)
            t.parent.subtrees.unshift(t)
            t.parent.current = 0

            t = t.parent
        }

        t = tree

        while (t.subtrees.length !== 0) {
            let [x] = t.subtrees.splice(t.current, 1)
            t.subtrees.unshift(x)
            t.current = 0

            t = x
        }

        this.setCurrentTreePosition(tree, index)
    }

    shiftVariation(tree, index, step, {setUndoPoint = true} = {}) {
        if (!tree.parent) return

        if (setUndoPoint) this.setUndoPoint('Undo Shift Variation')
        this.closeDrawer()
        this.setMode('play')

        let subtrees = tree.parent.subtrees
        let m = subtrees.length
        let i = subtrees.indexOf(tree)
        let iNew = ((i + step) % m + m) % m

        subtrees.splice(i, 1)
        subtrees.splice(iNew, 0, tree)

        this.setCurrentTreePosition(...this.state.treePosition)
    }

    removeNode(tree, index, {suppressConfirmation = false, setUndoPoint = true} = {}) {
        if (!tree.parent && index === 0) {
            dialog.showMessageBox('The root node cannot be removed.', 'warning')
            return
        }

        if (suppressConfirmation !== true
        && setting.get('edit.show_removenode_warning')
        && dialog.showMessageBox(
            'Do you really want to remove this node?',
            'warning',
            ['Remove Node', 'Cancel'], 1
        ) === 1) return

        if (setUndoPoint) this.setUndoPoint('Undo Remove Node')
        this.closeDrawer()
        this.setMode('play')

        // Remove node

        let prev = gametree.navigate(tree, index, -1)

        if (index !== 0) {
            tree.nodes.splice(index, tree.nodes.length)
            tree.current = null
            tree.subtrees.length = 0
        } else {
            let parent = tree.parent
            let i = parent.subtrees.indexOf(tree)

            parent.subtrees.splice(i, 1)
            if (parent.current >= 1) parent.current--
            gametree.reduce(parent)
        }

        if (!prev) prev = this.state.treePosition
        this.setCurrentTreePosition(...prev)
    }

    removeOtherVariations(tree, index, {suppressConfirmation = false, setUndoPoint = true} = {}) {
        if (suppressConfirmation !== true
        && setting.get('edit.show_removeothervariations_warning')
        && dialog.showMessageBox(
            'Do you really want to remove all other variations?',
            'warning',
            ['Remove Variations', 'Cancel'], 1
        ) == 1) return

        // Save undo information

        if (setUndoPoint) this.setUndoPoint('Undo Remove Other Variations')
        this.closeDrawer()
        this.setMode('play')

        // Remove all subsequent variations

        let t = tree

        while (t.subtrees.length != 0) {
            t.subtrees = [t.subtrees[t.current]]
            t.current = 0

            t = t.subtrees[0]
        }

        // Remove all precedent variations

        t = tree

        while (t.parent != null) {
            t.parent.subtrees = [t]
            t.parent.current = 0

            t = t.parent
        }

        this.setCurrentTreePosition(tree, index)
    }

    // Menus

    openNodeMenu(tree, index, options = {}) {
        if (this.state.mode === 'scoring') return

        let template = [
            {
                label: 'C&opy Variation',
                click: () => this.copyVariation(tree, index)
            },
            {
                label: 'C&ut Variation',
                click: () => this.cutVariation(tree, index)
            },
            {
                label: '&Paste Variation',
                click: () => this.pasteVariation(tree, index)
            },
            {type: 'separator'},
            {
                label: 'Make &Main Variation',
                click: () => this.makeMainVariation(tree, index)
            },
            {
                label: "Shift &Left",
                click: () => this.shiftVariation(tree, index, -1)
            },
            {
                label: "Shift Ri&ght",
                click: () => this.shiftVariation(tree, index, 1)
            },
            {type: 'separator'},
            {
                label: '&Flatten',
                click: () => this.flattenVariation(tree, index)
            },
            {
                label: '&Remove Node',
                click: () => this.removeNode(tree, index)
            },
            {
                label: 'Remove &Other Variations',
                click: () => this.removeOtherVariations(tree, index)
            }
        ]

        helper.popupMenu(template, options.x, options.y)
    }

    openCommentMenu(tree, index, options = {}) {
        let node = tree.nodes[index]

        let template = [
            {
                label: '&Clear Annotations',
                click: () => {
                    this.setComment(tree, index, {positionAnnotation: null, moveAnnotation: null})
                }
            },
            {type: 'separator'},
            {
                label: 'Good for &Black',
                type: 'checkbox',
                data: {positionAnnotation: 'GB'}
            },
            {
                label: '&Unclear Position',
                type: 'checkbox',
                data: {positionAnnotation: 'UC'}
            },
            {
                label: '&Even Position',
                type: 'checkbox',
                data: {positionAnnotation: 'DM'}
            },
            {
                label: 'Good for &White',
                type: 'checkbox',
                data: {positionAnnotation: 'GW'}
            }
        ]

        if ('B' in node || 'W' in node) {
            template.push(
                {type: 'separator'},
                {
                    label: '&Good Move',
                    type: 'checkbox',
                    data: {moveAnnotation: 'TE'}
                },
                {
                    label: '&Interesting Move',
                    type: 'checkbox',
                    data: {moveAnnotation: 'IT'}
                },
                {
                    label: '&Doubtful Move',
                    type: 'checkbox',
                    data: {moveAnnotation: 'DO'}
                },
                {
                    label: 'B&ad Move',
                    type: 'checkbox',
                    data: {moveAnnotation: 'BM'}
                }
            )
        }

        template.push(
            {type: 'separator'},
            {
                label: '&Hotspot',
                type: 'checkbox',
                data: {hotspot: true}
            }
        )

        for (let item of template) {
            if (!('data' in item)) continue

            let [key] = Object.keys(item.data)
            let prop = key === 'hotspot' ? 'HO' : item.data[key]

            item.checked = prop in node
            if (item.checked) item.data[key] = null

            item.click = () => this.setComment(tree, index, item.data)
        }

        helper.popupMenu(template, options.x, options.y)
    }

    // GTP Engines

    attachEngines(...engines) {
        let {engineCommands, attachedEngines} = this.state

        if (helper.vertexEquals([...engines].reverse(), attachedEngines)) {
            // Just swap engines

            this.attachedEngineControllers.reverse()
            this.engineStates.reverse()

            this.setState({
                engineCommands: engineCommands.reverse(),
                attachedEngines: engines
            })

            return
        }

        let command = name => new gtp.Command(null, name)

        for (let i = 0; i < attachedEngines.length; i++) {
            if (attachedEngines[i] === engines[i]) continue
            if (this.attachedEngineControllers[i]) this.attachedEngineControllers[i].stop()

            try {
               
                let controller = engines[i] ? new gtp.Controller(engines[i]) : null
                controller.on('command-sent', this.handleCommandSent.bind(this))

                this.attachedEngineControllers[i] = controller
                this.engineStates[i] = null

                controller.start()
                controller.sendCommand(command('name'))
                controller.sendCommand(command('version'))
                controller.sendCommand(command('protocol_version'))
                //xiarx
                controller.sendCommand(command('list_commands'))
                controller.sendCommand(command('clear_board')).then(response => {  
                    engineCommands[i] = response.content.split('\n')
                })

                /*
                controller.sendCommand(command('list_commands')).then(response => {
                    engineCommands[i] = response.content.split('\n')
                })
                */
                controller.on('stderr', ({content}) => {
                    this.setState(({consoleLog}) => ({
                        consoleLog: [...consoleLog, {
                            sign: this.state.attachedEngines.indexOf(engines[i]) === 0 ? 1 : -1,
                            name: controller.engine.name,
                            command: null,
                            response: new gtp.Response(null, content, false, true)
                        }]
                    }))
                })

                this.setState({engineCommands})
            } catch (err) {
                this.attachedEngineControllers[i] = null
                engines[i] = null
            }
        }

        this.setState({attachedEngines: engines})
    }

    detachEngines() {
        this.attachEngines(null, null)
    }

    suspendEngines() {
        for (let controller of this.attachedEngineControllers) {
            if (controller != null) controller.stop()
        }

        this.engineStates = [null, null]
    }

    async handleCommandSent({controller, command, getResponse}) {
        let sign = 1 - this.attachedEngineControllers.indexOf(controller) * 2
        if (sign > 1) sign = 0

        let entry = {sign, name: controller.engine.name, command}
        let maxLength = setting.get('console.max_history_count')

        this.setState(({consoleLog}) => {
            let newLog = consoleLog.slice(Math.max(consoleLog.length - maxLength + 1, 0))
            newLog.push(entry)

            return {consoleLog: newLog}
        })

        let response = await getResponse()
        let sabakiJsonMatch = response.content.match(/^#sabaki(.*)$/m) || ['', '{}']

        response.content = response.content.replace(/^#sabaki(.*)$/gm, '#sabaki{…}')     

        this.setState(({consoleLog}) => {
            let index = consoleLog.indexOf(entry)
            if (index < 0) return {}

            let newLog = [...consoleLog]
            newLog[index] = Object.assign({response}, entry)

            return {consoleLog: newLog}
        })

        // Handle Sabaki JSON

        let sabakiJson = JSON.parse(sabakiJsonMatch[1])

        if (sabakiJson.variations != null) {
            let subtrees = sgf.parse(sabakiJson.variations)

            if (subtrees.length > 0) {
                let {gameTrees} = this.state
                let [tree, index] = gametree.navigate(...this.state.treePosition, -1)
                let gameIndex = gameTrees.indexOf(gametree.getRoot(tree))
                let splitted = gametree.split(tree, index)

                for (let subtree of subtrees) {
                    subtree.parent = splitted
                }

                splitted.subtrees.push(...subtrees)
                gametree.reduce(splitted)

                gameTrees[gameIndex] = gametree.getRoot(splitted)

                this.setState({gameTrees})
                this.setCurrentTreePosition(...gametree.navigate(splitted, splitted.nodes.length - 1, 1))
            }
        }

        if (sabakiJson.node != null) {
            let nodeInfo = sgf.parse(`(;${sabakiJson.node})`)[0].nodes[0]
            let [tree, index] = this.state.treePosition
            let node = tree.nodes[index]

            for (let key in nodeInfo) {
                if (key in node) node[key].push(...nodeInfo[key])
                else node[key] = nodeInfo[key]
            }

            this.setCurrentTreePosition(tree, index)
        }

        if (sabakiJson.heatmap != null) {
            this.setState({heatMap: sabakiJson.heatmap})
        }
    }

    async syncEngines({passPlayer = null} = {}) {
        if (this.attachedEngineControllers.every(x => x == null)) return

        this.setBusy(true)

        let {treePosition} = this.state

        try {
            for (let i = 0; i < this.attachedEngineControllers.length; i++) {
                if (this.attachedEngineControllers[i] == null) continue

                let player = i === 0 ? 1 : -1
                let controller = this.attachedEngineControllers[i]
                let engineState = this.engineStates[i]

                this.engineStates[i] = await enginesyncer.sync(controller, engineState, treePosition)

                // Send pass if required

                if (passPlayer != null && passPlayer !== player) {
                    let color = passPlayer > 0 ? 'B' : 'W'
                    controller.sendCommand(new gtp.Command(null, 'play', color, 'pass'))
                }
            }
        } catch (err) {
            dialog.showMessageBox(err.message, 'warning')
            this.detachEngines()
        }

        this.setBusy(false)
    }

    async startGeneratingMoves({passPlayer = null, followUp = false} = {}) {

    	this.closeDrawer()

        if (followUp && !this.state.generatingMoves) {
            this.hideInfoOverlay()
            this.setBusy(false)
            return
        } else if (!followUp) {
            this.setState({generatingMoves: true})
        }

        await this.syncEngines({passPlayer})
     

        let {currentPlayer, rootTree} = this.inferredState
        let [color, opponent] = currentPlayer > 0 ? ['B', 'W'] : ['W', 'B']
        let [playerIndex, otherIndex] = currentPlayer > 0 ? [0, 1] : [1, 0]
        let playerController = this.attachedEngineControllers[playerIndex]
        let otherController = this.attachedEngineControllers[otherIndex]

        if (playerController == null) {
            if (otherController != null) {
                // Switch engines, so the attached engine can play
                let engines = [...this.state.attachedEngines].reverse() //交换黑白就是这里
                this.attachEngines(...engines)
                ;[playerController, otherController] = [otherController, playerController]
            } else {
                return
            }
        }

        if (!followUp && otherController != null) {
            this.flashInfoOverlay('进入人工智能自动下棋模式，按 Esc 键可暂停......')
        }

        //this.setBusy(true)//去掉免得两个人工智能下棋时，菜单永远恢复不了

        let response = await playerController.sendCommand(new gtp.Command(null, 'genmove', color))//这句执行后菜单就变灰了
        let sign = color === 'B' ? 1 : -1
        let pass = true
        let vertex = [-1, -1]
        let board = gametree.getBoard(rootTree, 0)

        if (response.content.toLowerCase() !== 'pass') {
            pass = false
            vertex = board.coord2vertex(response.content)
        }

        if (response.content.toLowerCase() === 'resign') {
            dialog.showMessageBox(`${playerController.engine.name} 已认输！`)

            this.stopGeneratingMoves()

            this.setBusy(false)//xiarx added 20180408

            this.hideInfoOverlay()
            this.makeResign()

            return
        }

        let previousNode = this.state.treePosition[0].nodes[this.state.treePosition[1]]
        let previousPass = ['W', 'B'].some(color => color in previousNode
            && !board.hasVertex(sgf.point2vertex(previousNode[color][0])))
        let doublePass = previousPass && pass

        this.makeMove(vertex, {player: sign})

        if (!doublePass && this.state.engineCommands[playerIndex].includes('sabaki-genmovelog')) {
            // Send Sabaki specific GTP command

            await playerController.sendCommand(new gtp.Command(null, 'sabaki-genmovelog'))
        }

        this.engineStates[playerIndex] = {
            komi: this.engineStates[playerIndex] != null && this.engineStates[playerIndex].komi,
            board: gametree.getBoard(...this.state.treePosition)
        }

        if (otherController != null && !doublePass) {
            await helper.wait(setting.get('gtp.move_delay'))
            this.startGeneratingMoves({passPlayer: pass ? sign : null, followUp: true})
        } else {
            this.stopGeneratingMoves()
            this.hideInfoOverlay()
            this.setBusy(false)
        }
    }

    stopGeneratingMoves() {
        this.showInfoOverlay('人工智能自动下棋模式已暂停，再次按 Esc 键可继续…')
        this.setState({generatingMoves: false})
    }

    // Render

    render(_, state) {
        // Calculate some inferred values

        let rootTree = gametree.getRoot(...state.treePosition)
        let scoreBoard, areaMap

        if (['scoring', 'estimator'].includes(state.mode)) {
            // Calculate area map

            scoreBoard = gametree.getBoard(...state.treePosition).clone()

            for (let vertex of state.deadStones) {
                let sign = scoreBoard.get(vertex)
                if (sign === 0) continue

                scoreBoard.captures[sign > 0 ? 1 : 0]++
                scoreBoard.set(vertex, 0)
            }

            areaMap = state.mode === 'estimator' 
                ? influence.map(scoreBoard.arrangement, {discrete: true})
                : influence.areaMap(scoreBoard.arrangement)
        }

        this.inferredState = {
            showSidebar: state.showGameGraph || state.showCommentBox,
            showLeftSidebar: state.showConsole,
            rootTree,
            gameIndex: state.gameTrees.indexOf(rootTree),
            gameInfo: this.getGameInfo(rootTree),
            currentPlayer: this.getPlayer(...state.treePosition),
            scoreBoard,
            areaMap
        }

        state = Object.assign(state, this.inferredState)

        return h('section',
            {
                class: classNames({
                    leftsidebar: state.showLeftSidebar,
                    sidebar: state.showSidebar,
                    [state.mode]: true
                })
            },

            h(ThemeManager),
            h(MainView, state),
            h(LeftSidebar, state),
            h(Sidebar, state),
            h(DrawerManager, state),

            h(InputBox, {
                text: state.inputBoxText,
                show: state.showInputBox,
                onSubmit: state.onInputBoxSubmit,
                onCancel: state.onInputBoxCancel
            }),

            h(BusyScreen, {show: state.busy > 0}),
            h(InfoOverlay, {text: state.infoOverlayText, show: state.showInfoOverlay})
        )
    }
}

// Render

render(h(App), document.body)
