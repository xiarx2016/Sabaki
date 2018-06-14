const {shell, clipboard, remote} = require('electron')
const {app} = remote || require('electron')

const setting = remote && remote.require('./setting')

const sabaki = typeof window !== 'undefined' && window.sabaki
const dialog = sabaki && require('./modules/dialog')
const gametree = sabaki && require('./modules/gametree')

let toggleSetting = key => setting.set(key, !setting.get(key))
let selectTool = tool => (sabaki.setMode('edit'), sabaki.setState({selectedTool: tool}))
let treePosition = () => sabaki.state.treePosition

let data = [
    {
        label: '开始',
        submenu: [
           /*
            {
                label: '远程开局',
                accelerator: 'CmdOrCtrl+T',
                click: () => sabaki.newGameByRemote(JSON.parse('{"COMMAD":"NEWGAME","PB":"NULL","PW":"LEELA","HA":3,"KM":7.5}'))
            },
            {
                label: '远程复盘',
                accelerator: 'CmdOrCtrl+L',
                click: () => sabaki.LoadGameByRemote(JSON.parse('{"COMMAD":"LOADGAME","PATH":"C:\\\\QsGo\\\\QsSabaki\\\\sgffiles\\\\1.sgf"}'))
            },
            {
                label: '远程死活题',
                accelerator: 'CmdOrCtrl+L',
                click: () => sabaki.ExerciseByRemote(JSON.parse('{"COMMAD":"EXERCISE","PATH":"C:\\\\QsGo\\\\QsSabaki\\\\sgffiles\\\\0001.sgf"}'))
            },
            {type: 'separator'},
            */
            {
                label: '下棋',
                accelerator: 'CmdOrCtrl+N',
                click: () => sabaki.newFile({playSound: true, showInfo: true})
            },           
            {
                label: '复盘',
                accelerator: 'CmdOrCtrl+O',
                click: () => sabaki.loadFile()
            },
            {
                label: '保存',
                accelerator: 'CmdOrCtrl+S',
                click: () => sabaki.saveFile(sabaki.state.representedFilename)
            }//,
            /*
            {
                label: '另存为…',
                accelerator: 'CmdOrCtrl+Shift+S',
                click: () => sabaki.saveFile()
            }
            */
        ]
    }
    /*,      
    {
        label: '人工智能',
        submenu: [
            {
                label: '配置人工智能…',
                click: () => (sabaki.setState({preferencesTab: 'engines'}), sabaki.openDrawer('preferences'))
            }
        ]
    }
    */
]

let findMenuItem = str => data.find(item => item.label.replace('&', '') === str)

// Modify menu for macOS

if (process.platform === 'darwin') {
    // Add 'App' menu

    let appMenu = [{role: 'about'}]
    let helpMenu = findMenuItem('Help')
    let items = helpMenu.submenu.splice(0, 3)

    appMenu.push(...items.slice(0, 2))

    // Remove original 'Preferences' menu item

    let fileMenu = findMenuItem('File')
    let preferenceItem = fileMenu.submenu.splice(fileMenu.submenu.length - 2, 2)[1]

    appMenu.push(
        {type: 'separator'},
        preferenceItem,
        {type: 'separator'},
        {submenu: [], role: 'services'},
        {
            label: 'Text',
            submenu: [
                {role: 'undo'},
                {role: 'redo'},
                {type: 'separator'},
                {role: 'cut'},
                {role: 'copy'},
                {role: 'paste'},
                {role: 'selectall'}
            ]
        },
        {type: 'separator'},
        {role: 'hide'},
        {role: 'hideothers'},
        {type: 'separator'},
        {role: 'quit'}
    )

    data.unshift({
        label: app.getName(),
        submenu: appMenu
    })

    // Add 'Window' menu

    data.splice(data.length - 1, 0, {
        submenu: [
            {
                label: 'New Window',
                clickMain: 'newWindow',
                enabled: true
            },
            {role: 'minimize'},
            {type: 'separator'},
            {role: 'front'}
        ],
        role: 'window'
    })

    // Remove 'Toggle Menu Bar' menu item

    let viewMenu = findMenuItem('View')
    viewMenu.submenu.splice(0, 1)
}

// Generate ids for all menu items

let generateIds = (menu, idPrefix = '') => {
    menu.forEach((item, i) => {
        item.id = idPrefix + i

        if ('submenu' in item) {
            generateIds(item.submenu, `${item.id}-`)
        }
    })
}

generateIds(data)

module.exports = exports = data

exports.clone = function(x = data) {
    if (Array.isArray(x)) {
        return [...Array(x.length)].map((_, i) => exports.clone(x[i]))
    } else if (typeof x === 'object') {
        let result = {}
        for (let key in x) result[key] = exports.clone(x[key])
        return result
    }

    return x
}
