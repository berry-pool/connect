window.parent.postMessage(
    {
        event: 'UI_EVENT',
        type: 'iframe-bootstrap',
    },
    '*',
);

const iframeScript = document.createElement('script');
iframeScript.setAttribute('type', 'text/javascript');
iframeScript.setAttribute('src', './js/iframe.55aa2db9e4b936190252.js');
iframeScript.setAttribute('async', 'false');
document.body.appendChild(iframeScript);