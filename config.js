// =====================================================================
//  CONFIGURAÇÃO DO APP FROTA
//  Preencha com os dados do seu projeto Firebase (veja o LEIA-ME.txt).
// =====================================================================
self.FROTA_CONFIG = {
  // Firebase → ⚙️ Configurações do projeto → Seus apps → App da Web → "Configuração do SDK"
  firebase: {
    apiKey: "AIzaSyCLCJro4TrmM9vO3BlSzZzvv6wPISZLmmw",
    authDomain: "frotasguepar.firebaseapp.com",
    projectId: "frotasguepar",
    storageBucket: "frotasguepar.firebasestorage.app",
    messagingSenderId: "472106649823",
    appId: "1:472106649823:web:9e50728f8a3952f38b016a",
  },

  // Plano grátis: deixe false. O aviso de carro liberado aparece com o app aberto ou minimizado.
  // Só mude para true se um dia ativar o plano Blaze e publicar a Cloud Function (pasta functions).
  notificacoesPush: false,
  vapidKey: "", // só necessário com notificacoesPush: true

  // WhatsApp da central/administração (com DDD, ex.: "11912345678"). Deixe "" para esconder o botão.
  whatsappCentral: "",

  // De quantos em quantos segundos o GPS do motorista é enviado enquanto ele está com um carro
  intervaloGpsSegundos: 60,

  // Duração máxima do vídeo da vistoria (segundos) e se ele é obrigatório
  videoMaxSegundos: 15,
  videoObrigatorio: true,
};
